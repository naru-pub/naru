import { callerKey } from "./addresses";
import { FunctionRevisions } from "./function-revisions";
import { DurableObject } from "cloudflare:workers";
import { createHash, randomUUID } from "node:crypto";
import {
  DataError,
  MAX_COLLECTIONS,
  MAX_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  MAX_SITE_BYTES,
  name,
  functionModule,
  permission,
  unreservedName,
  writePermission,
} from "../../control-plane/src/lib/site-data/validation";
import { uuidv7 } from "../../control-plane/src/lib/uuid";
import {
  decodeRevision,
  publicResult,
} from "../../control-plane/src/lib/site-data/protocol";
import { runFunction, type Host } from "./functions";
import { presented, queriedFields, ruleEntry, rulePredicate } from "./rules";

/** What each rule hook is in the owner's file, for errors. */
const HOOKS: Record<string, string> = {
  __naruReadable: "readable()",
  __naruWrite: "canWrite()",
  __naruView: "queryable",
  __naruPresent: "present()",
};
import { hashPassword, verifyPassword } from "./passwords";
import type { ModuleSources } from "./modules";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { quickjs } from "./quickjs";
import {
  documentOf,
  fieldIndex,
  listQuery,
  SCHEMA,
  type Row,
  type SqlValue,
} from "./query";
import type {
  Collection,
  EdgeConfiguration,
  ExecuteInput,
  ListInput,
  Outcome,
  ServeInput,
  Served,
  Snapshot,
  Usage,
  Dump,
} from "./types";
import { DUMP_TABLES } from "./types";

// One site's collections and documents, stored in SQLite: the request rules
// and storage. Its arguments and answers are in types.ts, its list query in
// query.ts. The control plane uses the same validation, filter and cursor
// modules.
// What lives in PostgreSQL stays there: the control plane resolves the owner,
// paid status and sign-in scope, then calls in with the outcome (`Access`).
//
// A Durable Object runs one request at a time, and every method here is
// synchronous inside `transactionSync`, so the object needs no owner-row lock
// or write queue: each request sees and leaves a consistent site.

const readOnlyStandby = () =>
  new DataError(
    503,
    "Naru's server is away: this site can be read, not changed, until it is back.",
    "UNAVAILABLE",
  );

const outsideScope = (collection: string) =>
  new DataError(
    403,
    `Collection ${collection} was not approved for this sign-in. Add it to signIn({ collections }) and sign in again.`,
    "ACCESS_DENIED",
  );
const unsupported = () =>
  new DataError(400, "Data contains unsupported characters or numbers.");
/** Anonymous requests a site may make each calendar month (UTC). */
const DEFAULT_MONTHLY_REQUESTS = 5_000_000;
/** The count is kept in memory and written every this many requests. */
const BUDGET_SAVE_EVERY = 25;

class BudgetSpent extends DataError {
  constructor(
    limit: number,
    public resetsAt: number,
  ) {
    super(
      429,
      `This site has used its ${limit.toLocaleString("en-US")} database requests for the month. They resume on ${new Date(resetsAt).toISOString().slice(0, 10)}.`,
      "RATE_LIMITED",
    );
  }
}
const nextMonth = (now: Date) =>
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
const rateLimited = () =>
  new DataError(429, "Public write rate limit reached. Try again next minute.");
/** Writes a member may make a minute, across the site's collections. */
const MEMBER_WRITES_PER_MINUTE = 30;
/** Function calls a member may make a minute. */
const MEMBER_CALLS_PER_MINUTE = 30;
const MEMBER_READS_PER_MINUTE = 120;
/**
 * Calls of exports a module opens to visitors, a minute: per address, and for
 * the whole site. A visitor's read-only call counts against the reads.
 */
const VISITOR_CALLS = { address: 20, site: 300 };
const VISITOR_READS = { address: 60, site: 900 };
/**
 * Rows SQLite may read a minute for a site's members and visitors: about 5 s
 * of the one thread every site shares, so a site whose queries scan (contains
 * over 100,000 documents, totals of big boards) slows itself, not the others.
 * The owner is never refused.
 */
const ROWS_PER_MINUTE = 5_000_000;
const busy = () =>
  new DataError(
    429,
    "This site has read as much as it may this minute. Try again next minute.",
    "RATE_LIMITED",
  );
/** Reads a minute by one address or member; see limitReader. */
const READS_PER_MINUTE = 600;
/** Live connections one site's object holds at once. */
const MAX_LIVE_CONNECTIONS = 1000;
/** A message a function sends, as JSON. */
const MAX_MESSAGE_BYTES = 4 * 1024;
type Message =
  | { to: "member"; member: string; data: unknown }
  | { to: "topic"; topic: string; data: unknown };

const unpublished = () =>
  new DataError(503, "Site functions have not been published.", "UNAVAILABLE");

function deletable(expected: number | undefined) {
  if (expected === 0)
    throw new DataError(400, "A delete can only be conditional on a revision.");
}
function expectedVersion(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new DataError(400, "ifVersion must be a non-negative integer.");
  return value;
}
function matchVersion(expected: number, actual: number | undefined) {
  if (expected === (actual ?? 0)) return;
  throw new DataError(
    409,
    expected === 0
      ? "The document already exists."
      : actual === undefined
        ? "The document was deleted after that revision was read."
        : "The document changed after that revision was read. Read it again before saving.",
    "CONFLICT",
  );
}

/** The v1 data contract rejects NUL and unpaired surrogates, in keys too. */
function storable(value: unknown): void {
  if (typeof value === "string") {
    if (value.includes("\u0000") || !value.isWellFormed()) throw unsupported();
  } else if (Array.isArray(value)) value.forEach(storable);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      storable(key);
      storable(item);
    }
}
function encode(data: unknown) {
  storable(data);
  const encoded = JSON.stringify(data);
  const size = Buffer.byteLength(encoded);
  if (size > MAX_DOCUMENT_BYTES)
    throw new DataError(413, "Document exceeds 64 KiB.");
  return { encoded, size };
}

export class SiteData extends DurableObject<Env> {
  private sql: SqlStorage;
  /** This month's anonymous requests, ahead of what is saved in `meta`. */
  private budget?: { month: string; used: number; unsaved: number };
  /**
   * The month's requests by kind, and the rows they read, kept for sizing
   * the budget from what sites do: saved with the budget, as
   * meta `stats:<YYYY-MM>`.
   */
  private stats?: { month: string; counts: Record<string, number> };
  private tally(kind: string, amount = 1) {
    const month = new Date().toISOString().slice(0, 7);
    if (!this.stats || this.stats.month !== month) {
      const saved = this.meta(`stats:${month}`);
      this.stats = { month, counts: saved ? JSON.parse(saved) : {} };
    }
    this.stats.counts[kind] = (this.stats.counts[kind] ?? 0) + amount;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.createTables();
    // Keepalives are answered without waking the object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  /**
   * A live connection the edge Worker admitted (website.ts): a visitor's, or
   * a member's whose ticket it checked, listening to up to eight topics. It
   * hibernates between messages, so an idle one costs nothing.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected a WebSocket.", { status: 426 });
    const until = this.meta("entitled_until");
    const now = Date.now();
    if (
      this.meta("owner_id") === null ||
      until === null ||
      Number(this.meta("confirmed_until") ?? 0) <= now ||
      (until !== "forever" && Number(until) <= now)
    )
      return new Response("Live connections are unavailable.", {
        status: 503,
      });
    if (this.ctx.getWebSockets().length >= MAX_LIVE_CONNECTIONS)
      return new Response("Too many live connections.", { status: 503 });
    const spent = this.run(() => this.spend("live"));
    if (!spent.ok)
      return new Response(spent.error.message, { status: spent.error.status });
    const member = request.headers.get("X-Naru-Member") || null;
    const topics = (request.headers.get("X-Naru-Topics") ?? "")
      .split(",")
      .filter(Boolean);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [
      "live",
      ...(member ? [`member:${member}`] : []),
      ...topics.map((topic) => `topic:${topic}`),
    ]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage() {
    // Listeners only listen; "ping" is answered without reaching here.
  }

  async webSocketClose(socket: WebSocket, code: number) {
    socket.close(code === 1005 ? 1000 : code);
  }

  /** Sends what a call's function sent, once the call has committed. */
  private deliver(messages: Message[]) {
    for (const message of messages) {
      const tag =
        message.to === "member"
          ? `member:${message.member}`
          : `topic:${message.topic}`;
      const text = JSON.stringify(
        message.to === "member"
          ? { type: "notice", data: message.data }
          : { type: "topic", topic: message.topic, data: message.data },
      );
      for (const socket of this.ctx.getWebSockets(tag))
        try {
          socket.send(text);
        } catch {
          /* closing already */
        }
    }
  }

  /** Closes a member's live connections, as their access ends. */
  async disconnect(input: { member: string }) {
    for (const socket of this.ctx.getWebSockets(`member:${name(input.member)}`))
      socket.close(4003, "Access ended.");
    return { ok: true as const, value: null };
  }

  private createTables() {
    this.sql.exec(SCHEMA);
    // Objects made before members existed have no author column. Added here,
    // as the object starts, rather than in a migration: there is no other
    // place an object's schema changes.
    if (
      !this.rows("PRAGMA table_info(documents)").some(
        (column) => column.name === "created_by",
      )
    )
      this.sql.exec("ALTER TABLE documents ADD COLUMN created_by TEXT");
    // A document's write secret (1.1.0), hashed; never read back out.
    if (
      !this.rows("PRAGMA table_info(documents)").some(
        (column) => column.name === "secret_hash",
      )
    )
      this.sql.exec("ALTER TABLE documents ADD COLUMN secret_hash TEXT");
    // The site's document count and bytes, kept by triggers on every write
    // path, so a write's quota check reads one row instead of every document.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        documents INTEGER NOT NULL,
        bytes INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS usage_insert AFTER INSERT ON documents BEGIN
        UPDATE usage SET documents = documents + 1, bytes = bytes + NEW.size_bytes WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS usage_delete AFTER DELETE ON documents BEGIN
        UPDATE usage SET documents = documents - 1, bytes = bytes - OLD.size_bytes WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS usage_update AFTER UPDATE OF size_bytes ON documents BEGIN
        UPDATE usage SET bytes = bytes - OLD.size_bytes + NEW.size_bytes WHERE id = 1;
      END;
    `);
    // Counted once, when an object first has the table.
    this.sql.exec(
      "INSERT OR IGNORE INTO usage (id, documents, bytes) SELECT 1, count(*), coalesce(sum(size_bytes), 0) FROM documents",
    );
  }
  private run<T>(work: () => T): Outcome<T> {
    try {
      return { ok: true, value: this.ctx.storage.transactionSync(work) };
    } catch (error) {
      if (error instanceof DataError)
        return {
          ok: false,
          error: {
            status: error.status,
            message: error.message,
            code: error.code,
            ...(error.details === undefined ? {} : { details: error.details }),
            ...(error.site ? { site: true } : {}),
            ...(error instanceof BudgetSpent
              ? { resetsAt: error.resetsAt }
              : {}),
          },
        };
      throw error;
    }
  }

  private rows(query: string, ...bindings: SqlValue[]): Row[] {
    const cursor = this.sql.exec(query, ...bindings);
    const rows = cursor.toArray() as Row[];
    this.rowsRead += cursor.rowsRead;
    return rows;
  }

  /** Every row SQLite has read through `rows`, and this minute's share for members and visitors. */
  private rowsRead = 0;
  private worked = { minute: 0, rows: 0 };
  private thisMinute() {
    const minute = Math.floor(Date.now() / 60000);
    if (this.worked.minute !== minute) this.worked = { minute, rows: 0 };
    return this.worked;
  }
  private rowsPerMinute() {
    const own = this.meta("rows_per_minute");
    if (own !== null) return Number(own);
    const configured = Number(
      (this.env as { SITE_ROWS_PER_MINUTE?: string }).SITE_ROWS_PER_MINUTE,
    );
    return configured > 0 ? configured : ROWS_PER_MINUTE;
  }
  /** Refuses a member's or visitor's request once the site has read its rows this minute. */
  private admitWork() {
    if (this.thisMinute().rows >= this.rowsPerMinute()) throw busy();
  }
  /** Runs a member's or visitor's work, counting the rows it read. */
  private metered<T>(work: () => T): T {
    const before = this.rowsRead;
    try {
      return work();
    } finally {
      const rows = this.rowsRead - before;
      this.thisMinute().rows += rows;
      this.tally("rows", rows);
    }
  }

  private meta(key: string): string | null {
    return (this.rows("SELECT value FROM meta WHERE key = ?", key)[0]?.value ??
      null) as string | null;
  }

  private setMeta(key: string, value: string | null) {
    if (value === null) this.sql.exec("DELETE FROM meta WHERE key = ?", key);
    else
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        key,
        value,
      );
  }

  /** The object belongs to one account; a second would be a routing bug. */
  private claim(ownerId: string) {
    const current = this.meta("owner_id");
    if (current === null) this.setMeta("owner_id", ownerId);
    else if (current !== ownerId)
      throw new DataError(503, "Site storage belongs to another account.");
  }

  private collection(id: string, row: Row) {
    const rules = this.meta(`rules:${id}`);
    const unique = this.uniqueFields(id);
    const indexes = this.indexFields(id);
    return {
      id,
      user_id: this.meta("owner_id"),
      ...row,
      ...(rules ? { rules } : {}),
      ...(unique.length ? { unique } : {}),
      ...(indexes.length ? { indexes } : {}),
    };
  }

  /** The top-level fields no two documents of a collection may share. */
  private uniqueFields(collectionId: string): string[] {
    const value = this.meta(`unique:${collectionId}`);
    return value ? (JSON.parse(value) as string[]) : [];
  }
  private uniqueIndex(collectionId: string, field: string) {
    if (!/^[0-9a-f-]{36}$/.test(collectionId))
      throw new Error("Unexpected collection ID.");
    const index = `documents_unique_${createHash("sha256").update(`${collectionId}\u0000${field}`).digest("hex").slice(0, 24)}`;
    return {
      index,
      // Collection IDs are UUIDs and fields passed NAME, so both are inlined
      // safely; the query below repeats the indexed expression exactly.
      create: `CREATE INDEX IF NOT EXISTS ${index} ON documents (json_extract(data, '$."${field}"')) WHERE collection_id = '${collectionId}'`,
    };
  }
  /** The top-level fields a collection's reads filter on, each indexed. */
  private indexFields(collectionId: string): string[] {
    const value = this.meta(`indexes:${collectionId}`);
    return value ? (JSON.parse(value) as string[]) : [];
  }
  /** Sets a collection's indexed fields: at most five top-level fields. */
  private setIndexes(collection: Collection, value: unknown) {
    const fields =
      value === null
        ? []
        : Array.isArray(value) && value.length <= 5
          ? [...new Set(value.map(name))]
          : (() => {
              throw new DataError(400, "indexes takes at most 5 field names.");
            })();
    const before = this.indexFields(collection.id);
    for (const field of before)
      if (!fields.includes(field))
        this.sql.exec(
          `DROP INDEX IF EXISTS ${fieldIndex(collection.id, field).index}`,
        );
    for (const field of fields)
      this.sql.exec(fieldIndex(collection.id, field).create);
    this.setMeta(
      `indexes:${collection.id}`,
      fields.length ? JSON.stringify(fields) : null,
    );
  }
  /**
   * Sets a collection's unique fields: at most three top-level fields whose
   * string or number values no two documents may share. Refused while
   * documents already share one.
   */
  private setUnique(collection: Collection, value: unknown) {
    const fields =
      value === null
        ? []
        : Array.isArray(value) && value.length <= 3
          ? [...new Set(value.map(name))]
          : (() => {
              throw new DataError(400, "unique takes at most 3 field names.");
            })();
    for (const field of this.uniqueFields(collection.id))
      this.sql.exec(
        `DROP INDEX IF EXISTS ${this.uniqueIndex(collection.id, field).index}`,
      );
    for (const field of fields) {
      const path = `'$."${field}"'`;
      const shared = this.rows(
        `SELECT json_extract(data, ${path}) AS value FROM documents
         WHERE collection_id = ? AND json_type(data, ${path}) IN ('text', 'integer', 'real')
         GROUP BY json_type(data, ${path}) IN ('text'), json_extract(data, ${path}) HAVING count(*) > 1 LIMIT 1`,
        collection.id,
      );
      if (shared.length)
        throw new DataError(
          409,
          `Documents in ${collection.name} already share ${field} ${JSON.stringify(shared[0].value)}. Change them first.`,
          "CONFLICT",
        );
      this.sql.exec(this.uniqueIndex(collection.id, field).create);
    }
    this.setMeta(
      `unique:${collection.id}`,
      fields.length ? JSON.stringify(fields) : null,
    );
  }
  /** Refuses writing `data` as document `id` when another holds a unique value. */
  private checkUnique(collection: Collection, id: string, data: unknown) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    for (const field of this.uniqueFields(collection.id)) {
      const value = (data as Record<string, unknown>)[field];
      if (typeof value !== "string" && typeof value !== "number") continue;
      const path = `'$."${field}"'`;
      // The partial index applies only to its own literal collection ID.
      if (!/^[0-9a-f-]{36}$/.test(collection.id))
        throw new Error("Unexpected collection ID.");
      const taken = this.rows(
        `SELECT id FROM documents WHERE collection_id = '${collection.id}' AND json_extract(data, ${path}) = ?
         AND json_type(data, ${path}) ${typeof value === "string" ? "= 'text'" : "IN ('integer', 'real')"} AND id != ? LIMIT 1`,
        value,
        id,
      );
      if (taken.length)
        throw new DataError(
          409,
          `Another document in ${collection.name} already has this ${field}.`,
          "CONFLICT",
          { unique: field },
        );
    }
  }

  private usage() {
    const row = this.rows("SELECT documents, bytes FROM usage WHERE id = 1")[0];
    return { documents: Number(row.documents), bytes: Number(row.bytes) };
  }

  /**
   * Reads a minute by one address (an IPv6 /64) or one member, kept in
   * memory: a script reading in a loop is refused long before it spends the
   * site's month, while a person browsing never meets it.
   */
  private readers = { minute: 0, counts: new Map<string, number>() };
  private limitReader(key: string) {
    const minute = Math.floor(Date.now() / 60000);
    if (this.readers.minute !== minute)
      this.readers = { minute, counts: new Map() };
    const count = (this.readers.counts.get(key) ?? 0) + 1;
    const limit =
      Number(
        (this.env as { SITE_READS_PER_MINUTE?: string }).SITE_READS_PER_MINUTE,
      ) || READS_PER_MINUTE;
    if (count > limit)
      throw new DataError(
        429,
        "Too many reads from here this minute. Try again next minute.",
        "RATE_LIMITED",
      );
    this.readers.counts.set(key, count);
  }

  /** Fixed-minute buckets: 60 public writes per site, 20 per caller. */
  private limitPublicWrite(clientIp?: string) {
    const window = Math.floor(Date.now() / 60000) * 60000;
    this.sql.exec("DELETE FROM rate_limits WHERE window_start < ?", window);
    const caller = createHash("sha256")
      .update(callerKey(clientIp))
      .digest("base64url");
    for (const [key, maximum] of [
      ["site", 60],
      [`ip:${caller}`, 20],
    ] as const) {
      const count = Number(
        this.rows("SELECT count FROM rate_limits WHERE key = ?", key)[0]
          ?.count ?? 0,
      );
      if (count >= maximum) throw rateLimited();
      this.sql.exec(
        "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET count = count + 1",
        key,
        window,
      );
    }
  }

  /**
   * A member's writes, or function calls, a minute, in fixed-minute buckets
   * like visitors'.
   */
  private limitMember(
    member: string,
    kind: "write" | "call" | "read" = "write",
  ) {
    const window = Math.floor(Date.now() / 60000) * 60000;
    this.sql.exec("DELETE FROM rate_limits WHERE window_start < ?", window);
    const key = kind === "write" ? `member:${member}` : `${kind}:${member}`;
    const count = Number(
      this.rows("SELECT count FROM rate_limits WHERE key = ?", key)[0]?.count ??
        0,
    );
    if (
      count >=
      (kind === "write"
        ? MEMBER_WRITES_PER_MINUTE
        : kind === "read"
          ? MEMBER_READS_PER_MINUTE
          : MEMBER_CALLS_PER_MINUTE)
    )
      throw new DataError(
        429,
        `Member ${kind} rate limit reached. Try again next minute.`,
      );
    this.sql.exec(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET count = count + 1",
      key,
      window,
    );
  }

  private written(collectionId: string, id: string) {
    const row = this.rows(
      "SELECT data, version, created_at, updated_at, created_by FROM documents WHERE collection_id = ? AND id = ?",
      collectionId,
      id,
    )[0];
    return {
      data: JSON.parse(row.data as string),
      version: Number(row.version),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
      createdBy: (row.created_by ?? null) as string | null,
    };
  }

  /**
   * `author` is the member writing, recorded only when the write creates the
   * document: a replacement keeps who created it, as it keeps when.
   */
  private upsert(
    collectionId: string,
    id: string,
    encoded: string,
    size: number,
    author: string | null,
    secretHash: string | null = null,
  ) {
    this.trackMedia(collectionId, id, encoded);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO documents (collection_id, id, data, size_bytes, created_at, updated_at, created_by, secret_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (collection_id, id) DO UPDATE SET data = excluded.data,
         size_bytes = excluded.size_bytes, updated_at = excluded.updated_at,
         version = documents.version + 1`,
      collectionId,
      id,
      encoded,
      size,
      now,
      now,
      author,
      secretHash,
    );
  }

  private monthlyLimit() {
    const own = this.meta("monthly_requests");
    if (own !== null) return Number(own);
    const configured = Number(
      (this.env as { SITE_MONTHLY_REQUESTS?: string }).SITE_MONTHLY_REQUESTS,
    );
    return configured > 0 ? configured : DEFAULT_MONTHLY_REQUESTS;
  }

  /** The month's requests so far, its budget, and when it starts again. */
  private requestsThisMonth() {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const used =
      this.budget?.month === month
        ? this.budget.used
        : this.meta("budget_month") === month
          ? Number(this.meta("budget_used"))
          : 0;
    const saved = this.meta(`stats:${month}`);
    const kinds =
      this.stats?.month === month
        ? this.stats.counts
        : saved
          ? (JSON.parse(saved) as Record<string, number>)
          : {};
    return {
      used,
      limit: this.monthlyLimit(),
      resetsAt: nextMonth(now),
      kinds,
    };
  }

  /**
   * Counts one anonymous request against the month, or refuses it once the
   * month's budget is spent. Owners are never counted. Run on its own, not in
   * the request's transaction: a request that then fails was still served.
   * Losing up to BUDGET_SAVE_EVERY counts when the object is evicted is the
   * price of not writing on every read.
   */
  private spend(kind: string) {
    this.tally(kind);
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    if (!this.budget || this.budget.month !== month)
      this.budget = {
        month,
        used:
          this.meta("budget_month") === month
            ? Number(this.meta("budget_used"))
            : 0,
        unsaved: 0,
      };
    const limit = this.monthlyLimit();
    if (this.budget.used >= limit) throw new BudgetSpent(limit, nextMonth(now));
    this.budget.used += 1;
    this.budget.unsaved += 1;
    if (this.budget.unsaved >= BUDGET_SAVE_EVERY) {
      this.setMeta("budget_month", month);
      this.setMeta("budget_used", String(this.budget.used));
      if (this.stats)
        this.setMeta(
          `stats:${this.stats.month}`,
          JSON.stringify(this.stats.counts),
        );
      this.budget.unsaved = 0;
    }
  }

  /**
   * A collection or document request the control plane admitted: from the
   * control panel, a signed-in website, or a visitor the edge sent on.
   */
  async execute(input: ExecuteInput) {
    // Members are counted like visitors: the budget is what the site's
    // community may use, and only its owner is free of it.
    const counted = Boolean(input.access.anonymous || input.access.member);
    if (counted) {
      const spent = this.run(() => {
        this.admitWork();
        if (input.method === "GET")
          this.limitReader(
            input.access.member
              ? `member:${input.access.member}`
              : callerKey(input.clientIp),
          );
        this.spend(
          `${input.access.member ? "member" : "visitor"}_${input.method === "GET" ? "read" : "write"}`,
        );
      });
      if (!spent.ok) return spent;
    }
    try {
      const rules = await this.prepareRules(input);
      return this.run(() =>
        counted
          ? this.metered(() => this.executeSync(input, rules))
          : this.executeSync(input, rules),
      );
    } catch (error) {
      return this.run(() => {
        throw error;
      });
    }
  }

  /**
   * An anonymous request at the edge. The object answers it only while the
   * site has the database feature by the control plane's confirmed date
   * (`configure`). Otherwise the Worker sends the request on and the control
   * plane decides from PostgreSQL, which never lags: a site whose feature
   * has ended is refused there, and one whose owner just paid again is
   * served without waiting for the next sync.
   */
  async serve(input: ServeInput): Promise<Outcome<Served>> {
    const ownerId = this.meta("owner_id");
    const until = this.meta("entitled_until");
    const confirmed = Number(this.meta("confirmed_until") ?? 0);
    const now = Date.now();
    if (
      ownerId === null ||
      until === null ||
      confirmed <= now ||
      (until !== "forever" && Number(until) <= now)
    )
      return { ok: true, value: { pass: true } };
    const spent = this.run(() => {
      this.admitWork();
      if (input.method === "GET") this.limitReader(callerKey(input.clientIp));
      this.spend(input.method === "GET" ? "visitor_read" : "visitor_write");
    });
    if (!spent.ok) return spent;
    const command: ExecuteInput = {
      ...input,
      ownerId,
      access: { admin: false, allowedIds: null, anonymous: true },
    };
    try {
      const rules = await this.prepareRules(command);
      return this.run(() => {
        if (input.path.length > 2) throw new DataError(404, "Not found.");
        input.path.forEach(name);
        return this.metered(() => this.executeSync(command, rules));
      });
    } catch (error) {
      // Rules with no revision yet: the control plane publishes one.
      if (error instanceof DataError && error.message === unpublished().message)
        return { ok: true, value: { pass: true } };
      return this.run(() => {
        throw error;
      });
    }
  }

  /** Sets what `serve` relies on (see EdgeConfiguration); reports usage. */
  async configure(input: EdgeConfiguration): Promise<Outcome<Usage>> {
    return this.run(() => {
      this.claim(input.ownerId);
      this.setMeta(
        "entitled_until",
        input.entitledUntil === null ? "forever" : String(input.entitledUntil),
      );
      this.setMeta("confirmed_until", String(input.confirmedUntil));
      if (input.monthlyRequests !== undefined)
        this.setMeta(
          "monthly_requests",
          input.monthlyRequests === null ? null : String(input.monthlyRequests),
        );
      if (input.rowsPerMinute !== undefined)
        this.setMeta(
          "rows_per_minute",
          input.rowsPerMinute === null ? null : String(input.rowsPerMinute),
        );
      return this.usage();
    });
  }

  private executeSync(
    input: ExecuteInput,
    rules?: {
      file: string;
      entry: string;
      sources: ModuleSources;
      module: QuickJSWASMModule;
    },
  ) {
    const { path, method, access } = input;
    const body = input.body ?? {};
    const reading = method === "GET";
    this.claim(input.ownerId);
    const { admin, allowedIds } = access;
    let publicRead = false;
    if (!path.length) {
      if (allowedIds !== null)
        throw new DataError(403, "Website tokens only allow document access.");
      if (!admin) throw new DataError(403, "Admin access required.");
      if (method === "GET")
        return {
          result: {
            collections: this.rows(
              "SELECT id, name, read_access, write_access FROM collections ORDER BY name",
            ).map((row) => this.collection(row.id as string, row)),
            // For the owner's /database: what the site holds, and what its
            // members and visitors have used of the month's requests.
            usage: { ...this.usage(), requests: this.requestsThisMonth() },
          },
          publicRead,
        };
      // Several collections in one request, all or none: { names: [...] }.
      if (method === "DELETE") {
        const names = body.names;
        if (!Array.isArray(names) || !names.length || names.length > 100)
          throw new DataError(400, "Name 1–100 collections to delete.");
        const targets = names.map((value) => {
          const found = this.rows(
            "SELECT id, name, read_access, write_access FROM collections WHERE name = ?",
            name(value),
          )[0];
          if (!found)
            throw new DataError(
              404,
              `Collection ${String(value)} does not exist.`,
            );
          return found as unknown as Collection;
        });
        for (const target of targets) this.deleteCollection(target);
        return {
          result: { deleted: targets.map((target) => target.name) },
          publicRead,
        };
      }
      if (method !== "POST") throw new DataError(405, "Method not allowed.");
      const collectionName = unreservedName(body.name);
      if (
        this.rows("SELECT id FROM collections WHERE name = ?", collectionName)
          .length
      )
        throw new DataError(409, "Collection exists.");
      if (
        Number(
          this.rows("SELECT count(*) AS count FROM collections")[0].count,
        ) >= MAX_COLLECTIONS
      )
        throw new DataError(409, "Collection limit reached.", "QUOTA_EXCEEDED");
      const created = {
        name: collectionName,
        read_access: permission(body.read ?? "admin"),
        write_access: writePermission(body.write ?? "admin"),
      };
      const id = uuidv7();
      this.sql.exec(
        "INSERT INTO collections (id, name, read_access, write_access) VALUES (?, ?, ?, ?)",
        id,
        created.name,
        created.read_access,
        created.write_access,
      );
      return {
        result: { collection: this.collection(id, created) },
        publicRead,
      };
    }
    const found = this.rows(
      "SELECT id, name, read_access, write_access FROM collections WHERE name = ?",
      path[0],
    )[0];
    if (!found)
      throw new DataError(
        404,
        `Collection ${path[0]} does not exist. Create it in the control panel.`,
      );
    const collection = found as unknown as Collection;
    if (allowedIds !== null && !allowedIds.includes(collection.id))
      throw outsideScope(collection.name);
    if (path.length === 1 && (method === "PATCH" || method === "DELETE")) {
      if (allowedIds !== null)
        throw new DataError(403, "Website tokens cannot manage collections.");
      if (!admin) throw new DataError(403, "Admin access required.");
      if (method === "DELETE") {
        this.deleteCollection(collection);
        return { result: { success: true }, publicRead };
      }
      if (Object.hasOwn(body, "unique"))
        this.setUnique(collection, body.unique);
      if (Object.hasOwn(body, "indexes"))
        this.setIndexes(collection, body.indexes);
      if (Object.hasOwn(body, "rules")) {
        this.setMeta(
          `rules:${collection.id}`,
          body.rules === null ? null : name(body.rules),
        );
      }
      const updated = {
        name: collection.name,
        read_access: permission(body.read),
        write_access: writePermission(body.write),
      };
      this.sql.exec(
        "UPDATE collections SET read_access = ?, write_access = ? WHERE id = ?",
        updated.read_access,
        updated.write_access,
        collection.id,
      );
      return {
        result: { collection: this.collection(collection.id, updated) },
        publicRead,
      };
    }
    const ruleFile = this.meta(`rules:${collection.id}`);
    if (!admin && ruleFile && rules?.file !== ruleFile)
      throw new DataError(503, "Collection rules changed; retry the request.");
    const ruleHost = this.functionHost();
    const ruleName = `_naru/rules/${ruleFile}.js`;
    const invokeRule = (hook: string, args: unknown) => {
      if (!rules) throw new DataError(503, "Collection rules are unavailable.");
      const loaded = rules;
      const entry = ruleEntry(loaded.entry);
      try {
        return runRule();
      } catch (error) {
        // A rule's own mistake names the rule: "Function failed" alone
        // leaves the owner guessing which file and which hook.
        if (
          error instanceof DataError &&
          !error.site &&
          error.status === 400 &&
          error.message.startsWith("Function failed: ")
        )
          throw new DataError(
            400,
            `Collection rule ${ruleName} failed in ${HOOKS[hook]} for ${collection.name}: ${error.message.slice("Function failed: ".length)}`,
          );
        throw error;
      }
      function runRule() {
        return runFunction(
          loaded.module,
          {
            ...entry,
            modules: loaded.sources,
            name: hook,
            args,
            member: access.member ?? null,
            now: Date.now(),
            readonly: true,
            // A page of trimmed documents can be as large as the page itself.
            ...(hook === "__naruPresent"
              ? { maxResultBytes: 101 * 64 * 1024 }
              : {}),
          },
          ruleHost,
        );
      }
    };
    // A rule that exports `present` trims what non-owners read, and allows
    // queries only on its `queryable` fields, so hidden values cannot be
    // probed by filtering on them.
    let view: string[] | null | undefined;
    const ruleView = () => {
      if (view === undefined)
        view =
          !admin && ruleFile
            ? (invokeRule("__naruView", {}) as string[] | null)
            : null;
      return view;
    };
    const present = <T extends { id: string; data: unknown } | null>(
      documents: T[],
    ): T[] => {
      if (!ruleView()) return documents;
      const shown = documents.filter((document) => document !== null);
      if (!shown.length) return documents;
      const data = invokeRule("__naruPresent", {
        collection: collection.name,
        documents: shown,
      }) as unknown[];
      const byId = new Map(
        shown.map((document, index) => [document!.id, presented(data[index])]),
      );
      return documents.map((document) =>
        document === null
          ? document
          : { ...document, data: byId.get(document.id) },
      );
    };
    const authorization =
      reading && !admin && ruleFile
        ? rulePredicate(
            invokeRule("__naruReadable", {
              collection: collection.name,
              operation: path.length === 2 ? "get" : "list",
              id: path[1] ?? null,
              filter: input.filter ?? {},
              where: input.where ?? null,
            }),
            `Collection rule ${ruleName} readable() for ${collection.name} returned an invalid predicate`,
          )
        : undefined;
    const checkWrite = (before: unknown, after: unknown, operation: string) => {
      if (admin || !ruleFile) return;
      const answer = invokeRule("__naruWrite", {
        collection: collection.name,
        before,
        after,
        operation,
        secret: secretMatches,
      });
      if (answer !== true)
        throw new DataError(
          403,
          `Collection rule ${ruleName} refused this ${operation} on ${collection.name}: ${answer}. A write is allowed only when canWrite returns true; to tell the visitor why not, call ctx.fail(code, message) there.`,
          "ACCESS_DENIED",
        );
    };
    const member = access.member ?? null;
    if (method === "GET" && ruleView()) {
      const allowed = ruleView()!;
      const asked = queriedFields(input).filter(
        (field) => !allowed.includes(field),
      );
      if (asked.length)
        throw new DataError(
          400,
          `Collection ${collection.name} can be queried only on ${allowed.join(", ") || "its metadata"}; not ${asked.join(", ")}.`,
        );
    }
    if (method === "GET") {
      const level = collection.read_access;
      if (!(admin || level === "world" || (level === "member" && member)))
        throw new DataError(
          403,
          level === "member"
            ? `Collection ${collection.name} is for the site's members. Sign in as a member.`
            : `Collection ${collection.name} is not publicly readable. Change its read access in the control panel, or sign in.`,
        );
      // Identical rows for any stranger, so a shared cache may hold them.
      publicRead = level === "world" && access.anonymous && !ruleFile;
      if (input.ids !== undefined) {
        if (path.length !== 1)
          throw new DataError(400, "Batch reads target a collection.");
        let values: unknown;
        try {
          values = JSON.parse(input.ids);
        } catch {
          throw new DataError(400, "Invalid IDs.");
        }
        if (!Array.isArray(values) || values.length > 100)
          throw new DataError(400, "Batch reads need at most 100 IDs.");
        const ids = values.map(name);
        const unique = [...new Set(ids)];
        const rows = unique.length
          ? this.rows(
              `SELECT id, data, version, created_at, updated_at, created_by FROM documents WHERE collection_id = ? AND id IN (${unique.map(() => "?").join(",")})${authorization ? ` AND (${authorization.sql})` : ""}`,
              collection.id,
              ...unique,
              ...(authorization?.bindings ?? []),
            )
          : [];
        const found = new Map(rows.map((row) => [row.id, documentOf(row)]));
        return {
          result: {
            documents: present(ids.map((id) => found.get(id) ?? null)),
          },
          publicRead,
        };
      }
      if (path.length === 2) {
        const row = this.rows(
          "SELECT id, data, version, created_at, updated_at, created_by FROM documents WHERE collection_id = ? AND id = ?",
          collection.id,
          path[1],
        )[0];
        if (!row) throw new DataError(404, "Document not found.");
        if (authorization) {
          const visible = this.rows(
            `SELECT id FROM documents WHERE collection_id = ? AND id = ? AND (${authorization.sql})`,
            collection.id,
            path[1],
            ...authorization.bindings,
          );
          if (!visible.length) throw new DataError(404, "Document not found.");
        }
        return {
          result: { document: present([documentOf(row)])[0] },
          publicRead,
        };
      }
      const page = this.list(collection, input, authorization);
      return {
        result: { ...page, documents: present(page.documents) },
        publicRead,
      };
    }
    const creating = method === "POST" && path.length === 1;
    const level = collection.write_access;
    // A write secret (1.1.0): given when adding, it lets whoever knows it
    // replace or delete the document later, as a guest's password does.
    const secret = body.secret;
    if (
      secret !== undefined &&
      (typeof secret !== "string" || !secret || secret.length > 256)
    )
      throw new DataError(400, "A secret is 1–256 characters.");
    const stored =
      path.length === 2 && !creating
        ? (this.rows(
            "SELECT secret_hash FROM documents WHERE collection_id = ? AND id = ?",
            collection.id,
            path[1],
          )[0]?.secret_hash as string | null | undefined)
        : undefined;
    // true or false when a secret was given for a document that has one.
    const secretMatches =
      typeof secret === "string" && stored
        ? verifyPassword(secret, stored) === true
        : null;
    // Adding is open to anyone in `create` and to members in `member`.
    // Replacing and deleting there is the owner's, and in `member` also the
    // author's, checked against the document below.
    const authorOnly = !admin && !ruleFile && level === "member" && !creating;
    if (!(
      admin ||
      level === "world" ||
      (level === "create" && (creating || secretMatches === true)) ||
      (level === "member" && member)
    ))
      throw new DataError(
        403,
        level === "member"
          ? `Only the site's members can write to collection ${collection.name}. Sign in as a member.`
          : creating
            ? `Visitors cannot add to collection ${collection.name}. Change its write access in the control panel, or sign in.`
            : `Only a signed-in owner can change documents in collection ${collection.name}.`,
      );
    // Every write past this point is reachable without an owner credential
    // when the collection allows it, so all of them are counted.
    if (member && !admin) this.limitMember(member);
    else if (!admin) this.limitPublicWrite(input.clientIp);
    const expected = expectedVersion(input.ifVersion);
    const current = (id: string) =>
      this.rows(
        "SELECT size_bytes, version, created_by FROM documents WHERE collection_id = ? AND id = ?",
        collection.id,
        id,
      )[0] as
        | { size_bytes: number; version: number; created_by: string | null }
        | undefined;
    if (method === "DELETE" && path.length === 2) {
      deletable(expected);
      const existing = current(path[1]);
      if (expected !== undefined) matchVersion(expected, existing?.version);
      // A missing document is already gone, as it is for the owner.
      if (authorOnly && existing && existing.created_by !== member)
        throw new DataError(
          403,
          `Members can delete only the documents they created in collection ${collection.name}.`,
        );
      if (existing)
        checkWrite(this.ruleDocument(collection.id, path[1]), null, "delete");
      this.removeDocument(collection.id, path[1]);
      return { result: { success: true }, publicRead };
    }
    if (!(creating || (method === "PUT" && path.length === 2)))
      throw new DataError(405, "Method not allowed.");
    if (!Object.hasOwn(body, "data"))
      throw new DataError(400, "data is required.");
    const id = path[1] ?? randomUUID();
    const existing = current(id);
    if (expected !== undefined) matchVersion(expected, existing?.version);
    // A member replaces what they created, and may create the one document
    // named by their own member ID: a profile, say, that no one else can
    // claim first.
    if (
      authorOnly &&
      (existing ? existing.created_by !== member : id !== member)
    )
      throw new DataError(
        403,
        existing
          ? `Members can replace only the documents they created in collection ${collection.name}.`
          : `Members can create a document with a chosen ID only under their own member ID in collection ${collection.name}. Use add() for others.`,
      );
    const { encoded, size } = encode(body.data);
    this.checkQuota(existing?.size_bytes, size);
    // Never overwrite on create, even in the event of an ID collision.
    if (creating && existing)
      throw new DataError(409, "Document ID collision. Retry creation.");
    this.checkUnique(collection, id, body.data);
    const before = this.ruleDocument(collection.id, id);
    checkWrite(
      before,
      {
        ...(before ?? {}),
        id,
        data: body.data,
        createdBy: before ? before.createdBy : admin ? null : member,
      },
      existing ? "update" : "create",
    );
    this.upsert(
      collection.id,
      id,
      encoded,
      size,
      admin ? null : member,
      creating && typeof secret === "string" ? hashPassword(secret) : null,
    );
    // A writer sees what they wrote as a reader would.
    const [result] = present([{ id, ...this.written(collection.id, id) }]);
    return { result, publicRead };
  }

  /** Refuses a write of `size` bytes, over a document of `existing`, past the site's quota. */
  private checkQuota(existing: number | undefined, size: number) {
    const usage = this.usage();
    if (
      usage.bytes - Number(existing ?? 0) + size > MAX_SITE_BYTES ||
      (existing === undefined && usage.documents >= MAX_DOCUMENTS)
    )
      throw new DataError(
        409,
        "Site database quota exceeded.",
        "QUOTA_EXCEEDED",
      );
  }

  private ruleDocument(collection: string, id: string) {
    const row = this.rows(
      "SELECT id, data, version, created_at, updated_at, created_by FROM documents WHERE collection_id = ? AND id = ?",
      collection,
      id,
    )[0];
    return row
      ? (publicResult(documentOf(row)) as {
          id: string;
          data: unknown;
          createdBy: string | null;
        })
      : null;
  }

  private async prepareRules(input: ExecuteInput) {
    if (
      input.access.admin ||
      !input.path.length ||
      (input.path.length === 1 && ["PATCH", "DELETE"].includes(input.method))
    )
      return;
    const row = this.rows(
      "SELECT id FROM collections WHERE name = ?",
      name(input.path[0]),
    )[0];
    const file = row ? this.meta(`rules:${row.id}`) : null;
    if (!file) return;
    if (!input.site)
      throw new DataError(503, "Collection rules need a site name.");
    // From the active function revision, like functions: a rule changes when
    // the site's _naru files are next published, all at once.
    const revision = this.meta("functions_revision");
    if (!revision) throw unpublished();
    let sources: ModuleSources, entry: string;
    try {
      const revisions = this.revisions(input.site);
      entry = await revisions.entry(revision, `rules/${file}`);
      sources = await revisions.graph(revision, entry);
    } catch (error) {
      if (error instanceof DataError && error.status === 404)
        throw new DataError(
          403,
          `Collection ${input.path[0]} uses _naru/rules/${file}.js, which the site's published files do not have; members and visitors are refused until it is published.`,
          "ACCESS_DENIED",
        );
      throw error;
    }
    return { file, entry, sources, module: await quickjs() };
  }

  private functionRevisions: FunctionRevisions | undefined;
  private revisions(site: string) {
    return (this.functionRevisions ??= new FunctionRevisions(
      this.env.SITE_FILES,
      site,
    ));
  }

  /** Activation only: snapshots and retirement tasks belong to the control plane. */
  async activateFunctions(input: { revision: string; generation: string }) {
    return this.run(() => {
      if (
        !/^[a-f0-9]{64}$/.test(input.revision) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          input.generation,
        )
      )
        throw new DataError(400, "Invalid function release.");
      const current = this.meta("functions_generation");
      // An older durable task must never reactivate code retired by a newer release.
      if (!current || input.generation > current) {
        this.setMeta("functions_revision", input.revision);
        this.setMeta("functions_generation", input.generation);
      }
      return { revision: this.meta("functions_revision") };
    });
  }

  /** Test fixture only: production snapshots are created in the control plane. */
  private async publishFunctions(input: { site: string }) {
    const previous = this.meta("functions_revision");
    let revision: string;
    try {
      revision = await this.revisions(input.site).publish();
    } catch (error) {
      return this.run(() => {
        throw error;
      });
    }
    return this.run(() => {
      if (this.meta("functions_revision") !== previous)
        throw new DataError(
          409,
          "Another function revision was published. Retry.",
          "CONFLICT",
        );
      this.setMeta("functions_revision", revision);
      return { revision };
    });
  }

  /**
   * What a function's ctx may do: anything the owner may with the site's
   * documents, in this call's transaction. What it writes has no member
   * author, so a member cannot then change it directly.
   */
  private functionHost(
    written = new Set<string>(),
    messages: Message[] = [],
  ): Host {
    const cachedCollections = new Map<string, Collection>();
    const collection = (value: unknown) => {
      const key = name(value);
      const cached = cachedCollections.get(key);
      if (cached) return cached;
      const found = this.rows(
        "SELECT id, name, read_access, write_access FROM collections WHERE name = ?",
        name(value),
      )[0];
      if (!found)
        throw new DataError(404, `Collection ${String(value)} does not exist.`);
      const target = found as unknown as Collection;
      cachedCollections.set(key, target);
      return target;
    };
    const document = (collectionId: string, id: string) =>
      this.rows(
        "SELECT id, data, version, created_at, updated_at, created_by FROM documents WHERE collection_id = ? AND id = ?",
        collectionId,
        id,
      )[0];
    // A write's condition, as the SDK's: { revision } or { absent: true }.
    const condition = (value: unknown, deleting = false) => {
      if (value === undefined || value === null) return undefined;
      const options = value as { condition?: unknown };
      if (typeof value !== "object" || Array.isArray(value))
        throw new DataError(400, "Write options must be an object.");
      if (options.condition === undefined) return undefined;
      const given = options.condition as Record<string, unknown>;
      if (
        !given ||
        typeof given !== "object" ||
        Array.isArray(given) ||
        Object.keys(given).length !== 1
      )
        throw new DataError(400, "condition must contain revision or absent.");
      if (typeof given.revision === "string")
        return decodeRevision(given.revision);
      if (given.absent === true && !deleting) return 0;
      throw new DataError(
        400,
        deleting
          ? "A delete can only be conditional on a revision."
          : "condition must contain revision or absent.",
      );
    };
    // A document's write secret (1.1.0), as a visitor's add({ secret }) sets it.
    const secretOption = (options: unknown) => {
      if (!options || typeof options !== "object") return undefined;
      const secret = (options as { secret?: unknown }).secret;
      if (secret === undefined) return undefined;
      if (typeof secret !== "string" || !secret || secret.length > 256)
        throw new DataError(400, "A secret is 1–256 characters.");
      return secret;
    };
    const write = (
      target: Collection,
      id: string,
      data: unknown,
      expected?: number,
      secret?: string,
    ) => {
      const existing = this.rows(
        "SELECT size_bytes, version FROM documents WHERE collection_id = ? AND id = ?",
        target.id,
        id,
      )[0] as { size_bytes: number; version: number } | undefined;
      if (expected !== undefined) matchVersion(expected, existing?.version);
      const { encoded, size } = encode(data);
      this.checkQuota(existing?.size_bytes, size);
      this.checkUnique(target, id, data);
      this.upsert(target.id, id, encoded, size, null);
      if (secret !== undefined)
        this.sql.exec(
          "UPDATE documents SET secret_hash = ? WHERE collection_id = ? AND id = ?",
          hashPassword(secret),
          target.id,
          id,
        );
      written.add(target.name);
      return publicResult(documentOf(document(target.id, id)));
    };
    return (operation, args) => {
      switch (operation) {
        case "random":
          return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
        case "get": {
          const row = document(collection(args[0]).id, name(args[1]));
          return row ? publicResult(documentOf(row)) : null;
        }
        case "getMany": {
          const target = collection(args[0]);
          if (!Array.isArray(args[1]) || args[1].length > 100)
            throw new DataError(400, "getMany needs at most 100 IDs.");
          const ids = args[1].map(name);
          if (!ids.length) return [];
          const unique = [...new Set(ids)];
          const rows = this.rows(
            `SELECT id, data, version, created_at, updated_at, created_by FROM documents WHERE collection_id = ? AND id IN (${unique.map(() => "?").join(",")})`,
            target.id,
            ...unique,
          );
          const found = new Map(
            rows.map((row) => [row.id, publicResult(documentOf(row))]),
          );
          return ids.map((id) => found.get(id) ?? null);
        }
        case "count": {
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const query = listQuery(collection(args[0]).id, {
            filter: options.filter,
            where: options.where,
            includeTotal: true,
          });
          return Number(
            this.rows(query.count!.sql, ...query.count!.bindings)[0].matched,
          );
        }
        case "list": {
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const target = collection(args[0]);
          return publicResult(
            this.list(target, {
              filter: options.filter,
              where: options.where,
              sort:
                options.sort === undefined
                  ? undefined
                  : JSON.stringify(options.sort),
              size: options.size as number | undefined,
              after: (options.after ?? undefined) as string | undefined,
              includeTotal: false,
            }),
          );
        }
        case "add":
          return write(
            collection(args[0]),
            randomUUID(),
            args[1],
            undefined,
            secretOption(args[2]),
          );
        case "set":
          if (args.length < 3)
            throw new DataError(400, "set(collection, id, data) needs data.");
          return write(
            collection(args[0]),
            name(args[1]),
            args[2],
            condition(args[3]),
            secretOption(args[3]),
          );
        case "secretMatches": {
          const secret = secretOption({ secret: args[2] });
          const row = this.rows(
            "SELECT secret_hash FROM documents WHERE collection_id = ? AND id = ?",
            collection(args[0]).id,
            name(args[1]),
          )[0];
          return Boolean(
            secret &&
            row?.secret_hash &&
            verifyPassword(secret, row.secret_hash) === true,
          );
        }
        case "notify":
        case "broadcast": {
          const target = name(args[0]);
          const data = args[1] ?? null;
          if (Buffer.byteLength(JSON.stringify(data)) > MAX_MESSAGE_BYTES)
            throw new DataError(400, "A message is at most 4 KiB of JSON.");
          messages.push(
            operation === "notify"
              ? { to: "member", member: target, data }
              : { to: "topic", topic: target, data },
          );
          return null;
        }
        case "mediaDelete": {
          // Queued with the call's writes; the control plane deletes the
          // file once they commit (releasedMedia).
          if (
            typeof args[0] !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              args[0],
            )
          )
            throw new DataError(400, "ctx.media.delete() needs an upload ID.");
          // Deleted on purpose: no longer kept by references either.
          this.sql.exec(
            "DELETE FROM managed_media WHERE id = ?",
            args[0].toLowerCase(),
          );
          this.sql.exec(
            "INSERT INTO media_releases (id, queued_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
            args[0].toLowerCase(),
            Date.now(),
          );
          return null;
        }
        case "delete": {
          const target = collection(args[0]);
          const id = name(args[1]);
          const expected = condition(args[2], true);
          if (expected !== undefined)
            matchVersion(
              expected,
              (
                this.rows(
                  "SELECT version FROM documents WHERE collection_id = ? AND id = ?",
                  target.id,
                  id,
                )[0] as { version: number } | undefined
              )?.version,
            );
          this.removeDocument(target.id, id);
          written.add(target.name);
          return null;
        }
        default:
          throw new DataError(400, `ctx has no ${operation}.`);
      }
    };
  }

  /**
   * A member, or the site's owner (`member` null), calls one of the site's
   * functions. An export its module declares read-only (`export const
   * readOnly = [...]`, read when the revision was published) runs with writes
   * forbidden and counts against the member's reads; any other against their
   * calls. A member's call is counted against the month and their budget
   * first, on its own: a call that then fails was still made. The owner's are
   * never counted. The function runs in one transaction; a failure rolls it
   * back. `written` names the collections it changed, for the caller's cache.
   */
  async call(input: {
    ownerId: string;
    site: string;
    member: string | null;
    /** No one signed in: only exports the module lists in `visitors`. */
    visitor?: boolean;
    /**
     * Only exports declared read-only may run: this copy is the standby,
     * answering while the mini is away, and must not change.
     */
    readOnlyOnly?: boolean;
    /** A visitor's address, which their calls are limited by. */
    clientIp?: string;
    /** The module, _naru/functions/<file>.js. */
    file: string;
    name: string;
    args: unknown;
  }): Promise<
    Outcome<{ result: unknown; written: string[]; mediaReleases?: number }>
  > {
    const visitor = input.member === null && input.visitor === true;
    let filename: string, sources, readonly;
    try {
      functionModule(input.file);
      name(input.name);
      const revision = this.meta("functions_revision");
      if (!revision) throw unpublished();
      const revisions = this.revisions(input.site);
      filename = await revisions.entry(revision, `functions/${input.file}`);
      sources = await revisions.graph(revision, filename);
      const declared = await revisions.declarations(
        revision,
        filename,
        input.name,
      );
      readonly = declared.readOnly;
      if (input.readOnlyOnly && !readonly) throw readOnlyStandby();
      if (visitor && !declared.visitors)
        throw new DataError(
          401,
          "Sign in as a member to use this function.",
          "AUTH_REQUIRED",
        );
    } catch (error) {
      if (error instanceof DataError)
        return this.run(() => {
          throw error;
        });
      throw error;
    }
    const admitted = this.run(() => {
      this.claim(input.ownerId);
      if (visitor || input.member !== null) this.admitWork();
      if (visitor) {
        this.spend(readonly ? "visitor_read_call" : "visitor_call");
        this.limitVisitor(input.clientIp, readonly);
        return;
      }
      if (input.member === null) return;
      this.spend(readonly ? "member_read_call" : "member_call");
      this.limitMember(input.member, readonly ? "read" : "call");
    });
    if (!admitted.ok) return admitted;
    const engine = await quickjs();
    const written = new Set<string>();
    const messages: Message[] = [];
    try {
      const counted = visitor || input.member !== null;
      const outcome = this.run(() => ({
        result: (counted
          ? <T>(work: () => T) => this.metered(work)
          : <T>(work: () => T) => work())(() =>
          runFunction(
            engine,
            {
              source: sources[filename],
              filename,
              modules: sources,
              name: input.name,
              args: input.args,
              member: input.member,
              owner: input.member === null && !visitor,
              visitor,
              now: Date.now(),
              readonly,
            },
            this.functionHost(written, messages),
          ),
        ),
        written: [...written].sort(),
        ...this.pendingMedia(),
      }));
      if (outcome.ok) this.deliver(messages);
      return outcome;
    } catch (error) {
      // Not the function's doing: the engine itself failed. The call retired
      // its instance (functions.ts), and the next starts a new one.
      console.error("A site function's engine failed", error);
      return {
        ok: false,
        error: {
          status: 503,
          message: "Function failed.",
          code: "UNAVAILABLE",
        },
      };
    }
  }

  /**
   * A visitor's call at the edge (website.ts): answered here only while the
   * edge may answer the site's visitors, like `serve`; otherwise the Worker
   * sends it on to the control plane.
   */
  async visit(input: {
    site: string;
    file: string;
    name: string;
    args: unknown;
    clientIp?: string;
    readOnlyOnly?: boolean;
  }): Promise<
    Outcome<
      { pass: true } | { pass?: undefined; result: unknown; written: string[] }
    >
  > {
    const ownerId = this.meta("owner_id");
    const until = this.meta("entitled_until");
    const now = Date.now();
    if (
      ownerId === null ||
      until === null ||
      Number(this.meta("confirmed_until") ?? 0) <= now ||
      (until !== "forever" && Number(until) <= now) ||
      !this.meta("functions_revision")
    )
      return { ok: true, value: { pass: true } };
    const outcome = await this.call({
      ...input,
      ownerId,
      member: null,
      visitor: true,
    });
    if (!outcome.ok) return outcome;
    const { result, written } = outcome.value;
    return { ok: true, value: { result, written } };
  }

  /** A visitor's calls a minute, by address and for the whole site. */
  private limitVisitor(clientIp: string | undefined, readonly: boolean) {
    const window = Math.floor(Date.now() / 60000) * 60000;
    this.sql.exec("DELETE FROM rate_limits WHERE window_start < ?", window);
    const kind = readonly ? "visitor-read" : "visitor-call";
    const limits = readonly ? VISITOR_READS : VISITOR_CALLS;
    const caller = createHash("sha256")
      .update(callerKey(clientIp))
      .digest("base64url");
    for (const [key, maximum] of [
      [`${kind}:site`, limits.site],
      [`${kind}:${caller}`, limits.address],
    ] as const) {
      const count = Number(
        this.rows("SELECT count FROM rate_limits WHERE key = ?", key)[0]
          ?.count ?? 0,
      );
      if (count >= maximum)
        throw new DataError(
          429,
          "Visitor call rate limit reached. Try again next minute.",
        );
      this.sql.exec(
        "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET count = count + 1",
        key,
        window,
      );
    }
  }

  /**
   * Deletes a collection with its documents, rules, unique fields and upload
   * references. Its uploads stay: media may be linked from anywhere.
   */
  private deleteCollection(collection: Collection) {
    this.setUnique(collection, null);
    this.setIndexes(collection, null);
    this.sql.exec(
      "DELETE FROM media_refs WHERE collection_id = ?",
      collection.id,
    );
    this.sql.exec(
      "DELETE FROM documents WHERE collection_id = ?",
      collection.id,
    );
    this.sql.exec("DELETE FROM collections WHERE id = ?", collection.id);
    this.setMeta(`rules:${collection.id}`, null);
  }

  /** Deletes a document and its upload references. */
  private removeDocument(collectionId: string, id: string) {
    this.trackMedia(collectionId, id, null);
    this.sql.exec(
      "DELETE FROM documents WHERE collection_id = ? AND id = ?",
      collectionId,
      id,
    );
  }

  /**
   * Managed uploads (1.1.0) a document's JSON names by address: the site's
   * media URLs end in `/<owner id>/<upload id>.<ext>`, in plain fields or
   * inside HTML alike. Only uploads registered as managed count.
   */
  private referencedMedia(encoded: string | null) {
    const owner = this.meta("owner_id");
    // Owners are UUIDs (once numbers, before every table took UUIDv7 keys).
    if (
      !encoded ||
      !owner ||
      !/^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
        owner,
      )
    )
      return [];
    const pattern = new RegExp(
      `https?://[^"\\\\\\s]+?/${owner}/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`,
      "g",
    );
    const ids = [...new Set([...encoded.matchAll(pattern)].map((m) => m[1]))];
    if (!ids.length) return [];
    return this.rows(
      `SELECT id FROM managed_media WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    ).map((row) => row.id as string);
  }

  /**
   * Moves a document's upload references to what `encoded` names (null:
   * none). References only mark uploads in the media library: an upload no
   * document names stays, since media may be linked from anywhere.
   */
  private trackMedia(collectionId: string, id: string, encoded: string | null) {
    const before = this.rows(
      "SELECT upload_id FROM media_refs WHERE collection_id = ? AND document_id = ?",
      collectionId,
      id,
    ).map((row) => row.upload_id as string);
    const after = this.referencedMedia(encoded);
    for (const upload of after)
      if (!before.includes(upload))
        this.sql.exec(
          "INSERT INTO media_refs (upload_id, collection_id, document_id) VALUES (?, ?, ?)",
          upload,
          collectionId,
          id,
        );
    for (const upload of before)
      if (!after.includes(upload))
        this.sql.exec(
          "DELETE FROM media_refs WHERE upload_id = ? AND collection_id = ? AND document_id = ?",
          upload,
          collectionId,
          id,
        );
  }

  /** Registers a finished upload as managed (1.1.0): its references are tracked. */
  async manageMedia(input: { ownerId: string; id: string }) {
    return this.run(() => {
      this.claim(input.ownerId);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          input.id,
        )
      )
        throw new DataError(400, "Invalid upload ID.");
      this.sql.exec(
        "INSERT INTO managed_media (id, registered_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
        input.id,
        Date.now(),
      );
      return true;
    });
  }

  /**
   * Which of `ids` (managed uploads) a document uses. Unreferenced uploads
   * stay until deleted (the control panel's media library marks them).
   * A document may name one without a reference on record (uploads made
   * while UUID owners went unmatched): those are recorded first.
   */
  async mediaReferences(input: { ids?: unknown }) {
    return this.run(() => {
      const ids = Array.isArray(input.ids)
        ? input.ids
            .filter((id): id is string => typeof id === "string")
            .slice(0, 100)
        : [];
      const referenced = (id: string) =>
        this.rows("SELECT 1 FROM media_refs WHERE upload_id = ? LIMIT 1", id)
          .length > 0;
      const used: string[] = [];
      for (const id of ids) {
        if (!referenced(id))
          for (const document of this.rows(
            "SELECT collection_id, id, data FROM documents WHERE instr(data, ?) > 0",
            id,
          ))
            this.trackMedia(
              document.collection_id as string,
              document.id as string,
              document.data as string,
            );
        if (referenced(id)) used.push(id);
      }
      return used;
    });
  }

  /** How many uploads functions queued for deletion, when any wait. */
  private pendingMedia() {
    const pending = Number(
      this.rows("SELECT count(*) AS n FROM media_releases")[0].n,
    );
    return pending ? { mediaReleases: pending } : {};
  }

  /** The uploads functions queued for deletion, oldest first. */
  async mediaReleases(input: { limit?: number }) {
    return this.run(() =>
      this.rows(
        "SELECT id FROM media_releases ORDER BY queued_at, id LIMIT ?",
        Math.min(Math.max(Number(input.limit) || 100, 1), 100),
      ).map((row) => row.id as string),
    );
  }

  /** Forgets queued uploads the control plane has deleted. */
  async releasedMedia(input: { ids: string[] }) {
    return this.run(() => {
      if (!Array.isArray(input.ids) || input.ids.length > 100)
        throw new DataError(400, "Release at most 100 uploads.");
      for (const id of input.ids)
        this.sql.exec("DELETE FROM media_releases WHERE id = ?", String(id));
      return this.pendingMedia().mediaReleases ?? 0;
    });
  }

  /** Tests only: replaces a functions module, or removes it (null). */
  async putFunctions(input: {
    site: string;
    file: string;
    source: string | null;
    folder?: "functions" | "rules" | "modules";
    /** False stores the file only, for a batch published by its last file. */
    publish?: boolean;
  }) {
    const folder =
      input.folder === "rules"
        ? "rules"
        : input.folder === "modules"
          ? "modules"
          : "functions";
    const key = `${input.site}/_naru/${folder}/${folder !== "rules" ? functionModule(input.file) : name(input.file)}.js`;
    if (input.source === null) await this.env.SITE_FILES.delete(key);
    else await this.env.SITE_FILES.put(key, input.source);
    if (input.publish === false) return { ok: true, value: null };
    const published = await this.publishFunctions({ site: input.site });
    if (!published.ok) return published;
    return { ok: true, value: null };
  }

  private list(
    collection: Collection,
    input: ListInput,
    authorization?: ReturnType<typeof rulePredicate>,
  ) {
    const query = listQuery(collection.id, input, authorization);
    const rows = this.rows(query.select.sql, ...query.select.bindings);
    const totalCount = query.count
      ? Number(this.rows(query.count.sql, ...query.count.bindings)[0].matched)
      : undefined;
    return { ...query.page(rows), totalCount };
  }

  /** A `_batch` of sets and deletes from the owner, all or nothing. */
  async batch(input: {
    ownerId: string;
    allowedIds: string[] | null;
    operations: unknown[];
  }) {
    return this.run(() => {
      this.claim(input.ownerId);
      const collections = this.rows(
        "SELECT id, name, read_access, write_access FROM collections",
      ) as unknown as Collection[];
      const results = [];
      for (const raw of input.operations) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new DataError(400, "Invalid batch operation.");
        const operation = raw as Record<string, unknown>;
        const collectionName = name(operation.collection);
        const id = name(operation.id);
        const collection = collections.find(
          (row) => row.name === collectionName,
        );
        if (!collection)
          throw new DataError(
            404,
            `Collection ${collectionName} does not exist. Create it in the control panel.`,
          );
        if (
          input.allowedIds !== null &&
          !input.allowedIds.includes(collection.id)
        )
          throw outsideScope(collectionName);
        const expected = expectedVersion(operation.ifVersion);
        if (operation.type === "delete") deletable(expected);
        if (expected !== undefined)
          matchVersion(
            expected,
            (
              this.rows(
                "SELECT version FROM documents WHERE collection_id = ? AND id = ?",
                collection.id,
                id,
              )[0] as { version: number } | undefined
            )?.version,
          );
        if (operation.type === "delete") {
          this.removeDocument(collection.id, id);
          results.push(null);
          continue;
        }
        if (operation.type !== "set" || !Object.hasOwn(operation, "data"))
          throw new DataError(400, "Batch operations must be set or delete.");
        const { encoded, size } = encode(operation.data);
        this.checkUnique(collection, id, operation.data);
        this.upsert(collection.id, id, encoded, size, null);
        const { version, createdAt, updatedAt } = this.written(
          collection.id,
          id,
        );
        // Metadata only: the caller already holds the data it wrote.
        results.push({ id, version, createdAt, updatedAt });
      }
      // Checked once at the end: a batch may
      // pass through a larger total on its way to a smaller one.
      const usage = this.usage();
      if (usage.bytes > MAX_SITE_BYTES || usage.documents > MAX_DOCUMENTS)
        throw new DataError(
          409,
          "Site database quota exceeded.",
          "QUOTA_EXCEEDED",
        );
      return { success: true, results };
    });
  }

  /** The named collections, or all of them, ordered by name. */
  async collections(input: { names?: string[] }) {
    return this.run(() => {
      const rows = this.rows(
        "SELECT id, name, read_access, write_access FROM collections ORDER BY name",
      ) as unknown as Collection[];
      // With each one's rules module and unique fields, when it has them.
      return (
        input.names
          ? rows.filter((row) => input.names!.includes(row.name))
          : rows
      ).map((row) => {
        const rules = this.meta(`rules:${row.id}`);
        const unique = this.uniqueFields(row.id);
        const indexes = this.indexFields(row.id);
        return {
          ...row,
          ...(rules ? { rules } : {}),
          ...(unique.length ? { unique } : {}),
          ...(indexes.length ? { indexes } : {}),
        };
      });
    });
  }

  /**
   * Creates the missing collections, empty, or none (null) when they would
   * pass the collection limit. Returns the names it created.
   */
  async createCollections(input: {
    ownerId: string;
    collections: Omit<Collection, "id">[];
  }) {
    return this.run(() => {
      if (!input.collections.length) return [];
      this.claim(input.ownerId);
      const count = Number(
        this.rows("SELECT count(*) AS count FROM collections")[0].count,
      );
      if (count + input.collections.length > MAX_COLLECTIONS) return null;
      const created: string[] = [];
      for (const collection of input.collections) {
        const inserted = this.rows(
          `INSERT INTO collections (id, name, read_access, write_access) VALUES (?, ?, ?, ?)
           ON CONFLICT (name) DO NOTHING RETURNING name`,
          uuidv7(),
          collection.name,
          collection.read_access,
          collection.write_access,
        );
        if (inserted.length) created.push(collection.name);
      }
      return created;
    });
  }

  /**
   * Gives collections the settings a page asked for at owner sign-in, all or
   * none: creates those that are missing and updates the others' access,
   * rules module and unique fields. Null when new ones would pass the
   * collection limit; a unique field documents already share fails it all.
   */
  async configureCollections(input: {
    ownerId: string;
    collections: (Omit<Collection, "id"> & {
      rules?: string | null;
      unique?: string[];
      indexes?: string[];
    })[];
  }) {
    return this.run(() => {
      this.claim(input.ownerId);
      const existing = (names: string[]) =>
        this.rows(
          `SELECT id, name, read_access, write_access FROM collections WHERE name IN (${names.map(() => "?").join(",")})`,
          ...names,
        ) as unknown as Collection[];
      const found = input.collections.length
        ? existing(input.collections.map((c) => c.name))
        : [];
      const missing = input.collections.filter(
        (c) => !found.some((row) => row.name === c.name),
      );
      const count = Number(
        this.rows("SELECT count(*) AS count FROM collections")[0].count,
      );
      if (count + missing.length > MAX_COLLECTIONS) return null;
      for (const collection of missing)
        this.sql.exec(
          "INSERT INTO collections (id, name, read_access, write_access) VALUES (?, ?, ?, ?)",
          uuidv7(),
          collection.name,
          collection.read_access,
          collection.write_access,
        );
      for (const row of existing(input.collections.map((c) => c.name))) {
        const wanted = input.collections.find((c) => c.name === row.name)!;
        this.sql.exec(
          "UPDATE collections SET read_access = ?, write_access = ? WHERE id = ?",
          wanted.read_access,
          wanted.write_access,
          row.id,
        );
        if (wanted.rules !== undefined)
          this.setMeta(`rules:${row.id}`, wanted.rules);
        if (wanted.unique !== undefined) this.setUnique(row, wanted.unique);
        if (wanted.indexes !== undefined) this.setIndexes(row, wanted.indexes);
      }
      return missing.map((c) => c.name);
    });
  }

  async export(): Promise<Outcome<Snapshot>> {
    return this.run(() => ({
      ownerId: this.meta("owner_id"),
      rules: Object.fromEntries(
        this.rows("SELECT key, value FROM meta WHERE key LIKE 'rules:%'").map(
          (row) => [String(row.key).slice(6), String(row.value)],
        ),
      ),
      unique: Object.fromEntries(
        this.rows("SELECT key, value FROM meta WHERE key LIKE 'unique:%'").map(
          (row) => [String(row.key).slice(7), JSON.parse(String(row.value))],
        ),
      ),
      indexes: Object.fromEntries(
        this.rows("SELECT key, value FROM meta WHERE key LIKE 'indexes:%'").map(
          (row) => [String(row.key).slice(8), JSON.parse(String(row.value))],
        ),
      ),
      ...(this.meta("functions_revision")
        ? {
            functions: {
              revision: this.meta("functions_revision")!,
              generation: this.meta("functions_generation"),
            },
          }
        : {}),
      collections: this.rows(
        "SELECT id, name, read_access, write_access FROM collections ORDER BY id",
      ) as unknown as Collection[],
      documents: this.rows(
        `SELECT collection_id, id, data, size_bytes, version, created_at, updated_at, created_by
         FROM documents ORDER BY collection_id, id`,
      ).map((row) => ({
        collection_id: row.collection_id as string,
        id: row.id as string,
        data: row.data as string,
        size_bytes: Number(row.size_bytes),
        version: Number(row.version),
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
        created_by: (row.created_by ?? null) as string | null,
      })),
    }));
  }

  /**
   * Replaces the whole site with `snapshot`, keeping its ids; the control
   * plane's configuration goes too. Only tests reach this and `export`.
   */
  async import(snapshot: Snapshot) {
    return this.run(() => {
      this.sql.exec("DELETE FROM documents");
      this.sql.exec("DELETE FROM collections");
      this.sql.exec("DELETE FROM rate_limits");
      this.sql.exec("DELETE FROM meta");
      this.budget = undefined;
      if (snapshot.ownerId !== null) this.setMeta("owner_id", snapshot.ownerId);
      for (const [id, file] of Object.entries(snapshot.rules ?? {}))
        this.setMeta(`rules:${id}`, name(file));
      for (const [id, fields] of Object.entries(snapshot.unique ?? {})) {
        this.setMeta(`unique:${id}`, JSON.stringify(fields));
        for (const field of fields)
          this.sql.exec(this.uniqueIndex(id, field).create);
      }
      for (const [id, fields] of Object.entries(snapshot.indexes ?? {})) {
        this.setMeta(`indexes:${id}`, JSON.stringify(fields));
        for (const field of fields) this.sql.exec(fieldIndex(id, field).create);
      }
      if (snapshot.functions) {
        this.setMeta("functions_revision", snapshot.functions.revision);
        this.setMeta("functions_generation", snapshot.functions.generation);
      }
      for (const collection of snapshot.collections)
        this.sql.exec(
          "INSERT INTO collections (id, name, read_access, write_access) VALUES (?, ?, ?, ?)",
          collection.id,
          collection.name,
          collection.read_access,
          collection.write_access,
        );
      for (const document of snapshot.documents)
        this.sql.exec(
          `INSERT INTO documents (collection_id, id, data, size_bytes, version, created_at, updated_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          document.collection_id,
          document.id,
          document.data,
          document.size_bytes,
          document.version,
          document.created_at,
          document.updated_at,
          // Snapshots taken before members existed have no author.
          document.created_by ?? null,
        );
    });
  }

  /**
   * What the site holds, as one hash and two counts, to tell whether the
   * standby on Cloudflare has it (cli/sync-standby.ts). Counters that every
   * read moves (the monthly budget, rate limits) are left out, and so is
   * what this records about the standby itself.
   */
  async fingerprint(): Promise<
    Outcome<{
      fingerprint: string;
      collections: number;
      documents: number;
      standby: string | null;
    }>
  > {
    return this.run(() => {
      const hash = createHash("sha256");
      for (const table of DUMP_TABLES) {
        if (table === "rate_limits") continue;
        for (const row of this.rows(`SELECT * FROM ${table} ORDER BY 1, 2`)) {
          if (table === "meta" && /^(budget_|standby_)/.test(String(row.key)))
            continue;
          hash.update(`${table}\u0000${JSON.stringify(row)}\n`);
        }
      }
      return {
        fingerprint: hash.digest("hex"),
        collections: Number(
          this.rows("SELECT count(*) AS n FROM collections")[0].n,
        ),
        documents: Number(
          this.rows("SELECT count(*) AS n FROM documents")[0].n,
        ),
        standby: this.meta("standby_fingerprint"),
      };
    });
  }

  /** Records which `fingerprint` the standby on Cloudflare now holds. */
  async markStandby(input: { fingerprint: string }) {
    return this.run(() => {
      if (!/^[a-f0-9]{64}$/.test(String(input?.fingerprint)))
        throw new DataError(400, "Expected a fingerprint.");
      this.setMeta("standby_fingerprint", input.fingerprint);
      return null;
    });
  }

  /**
   * Overwrites this copy with the mini's `dump`, whatever it held: the
   * standby on Cloudflare only (index.ts refuses it anywhere else).
   */
  async replace(input: Dump): Promise<Outcome<{ rows: number }>> {
    return this.run(() => {
      for (const table of DUMP_TABLES) this.sql.exec(`DELETE FROM ${table}`);
      return this.fill(input);
    });
  }

  /** Whether this object's database answers, for the health check. */
  async ping(): Promise<Outcome<null>> {
    return this.run(() => {
      this.rows("SELECT 1");
      return null;
    });
  }

  /**
   * Every row of every table, to move the site to another runtime (its
   * `restore`): collections, documents with their write secrets, managed
   * media and its references, queued releases, limits and settings.
   */
  async dump(): Promise<Outcome<Dump>> {
    return this.run(() => ({
      tables: Object.fromEntries(
        DUMP_TABLES.map((table) => [
          table,
          this.rows(`SELECT * FROM ${table}`) as Record<
            string,
            string | number | null
          >[],
        ]),
      ) as Dump["tables"],
    }));
  }

  /**
   * Fills an empty site with another runtime's `dump`. Refused once the site
   * has a collection, so a mistaken run cannot overwrite live data.
   */
  async restore(input: Dump): Promise<Outcome<{ rows: number }>> {
    return this.run(() => {
      if (this.rows("SELECT 1 FROM collections LIMIT 1").length)
        throw new DataError(409, "The site already has collections.");
      return this.fill(input);
    });
  }

  /** Writes a `dump` into tables `restore` or `replace` emptied. */
  private fill(input: Dump) {
    let rows = 0;
    for (const table of DUMP_TABLES) {
      const given = input?.tables?.[table];
      if (!Array.isArray(given))
        throw new DataError(400, `The dump has no ${table} table.`);
      // Column names come from this object's own schema, never the input.
      const columns = this.rows(`PRAGMA table_info(${table})`).map((column) =>
        String(column.name),
      );
      this.sql.exec(`DELETE FROM ${table}`);
      for (const row of given) {
        const present = columns.filter((column) => Object.hasOwn(row, column));
        this.sql.exec(
          `INSERT INTO ${table} (${present.join(", ")}) VALUES (${present.map(() => "?").join(", ")})`,
          ...present.map((column) => row[column] ?? null),
        );
        rows++;
      }
    }
    for (const row of this.rows(
      "SELECT key, value FROM meta WHERE key LIKE 'unique:%'",
    ))
      for (const field of JSON.parse(String(row.value)) as string[])
        this.sql.exec(this.uniqueIndex(String(row.key).slice(7), field).create);
    for (const row of this.rows(
      "SELECT key, value FROM meta WHERE key LIKE 'indexes:%'",
    ))
      for (const field of JSON.parse(String(row.value)) as string[])
        this.sql.exec(fieldIndex(String(row.key).slice(8), field).create);
    this.budget = undefined;
    return { rows };
  }

  /** Erases the site, for account deletion. */
  async erase(): Promise<Outcome<null>> {
    await this.ctx.storage.deleteAll();
    this.budget = undefined;
    // deleteAll drops the tables too; this instance may serve again.
    this.createTables();
    return { ok: true, value: null };
  }
}
