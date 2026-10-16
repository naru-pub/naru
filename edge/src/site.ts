import { callerKey } from "./addresses";
import { FunctionRevisions, migrationPath } from "./function-revisions";
import { routeModule } from "../../control-plane/src/lib/site-functions/routes";
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
  functionReference,
  permission,
  unreservedName,
  writePermission,
} from "../../control-plane/src/lib/site-data/validation";
import { uuidv7 } from "../../control-plane/src/lib/uuid";
import { runFunction, type Host } from "./functions";
import {
  bindings,
  checkPlan,
  classify,
  MAX_ROW_BYTES,
  MAX_ROWS,
  MAX_ROWS_READ,
  reserved,
  sqlFailure,
  statements,
  type PlanStep,
  type Tables,
} from "./sql";

/** A live connection, as its attachment keeps it across hibernation. */
type LiveSocket = {
  id: string;
  member: string | null;
  site: string;
  clientIp?: string;
};
/** The tables a call's site SQL read and wrote, for live queries. */
type SqlTables = { read: Set<string>; written: Set<string> };
/** Live queries a connection may hold, and a site in all. */
const MAX_SOCKET_SUBSCRIPTIONS = 20;
const MAX_SITE_SUBSCRIPTIONS = 5000;
/** Distinct queries one refresh re-runs; the rest wait for the next write. */
const MAX_REFRESH_RUNS = 200;
const liveSend = (socket: WebSocket, message: unknown) => {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    /* closing already */
  }
};

/** One of a release's SQL migrations (FunctionRevisions.migrations). */
type Migration = { name: string; sql: string; digest: string };

/** A row for a dump, which is JSON: a BLOB becomes { $base64 }. */
const dumpRow = (row: Row): DumpRow =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof ArrayBuffer
        ? { $base64: Buffer.from(value).toString("base64") }
        : value,
    ]),
  );
const fromDump = (value: DumpRow[string] | undefined): SqlValue =>
  value && typeof value === "object"
    ? new Uint8Array(Buffer.from(value.$base64, "base64")).buffer
    : (value ?? null);
import { hashPassword, verifyPassword } from "./passwords";
import { quickjs } from "./quickjs";
import {
  documentOf,
  fieldIndex,
  listQuery,
  SCHEMA,
  USAGE_SCHEMA,
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
import { DUMP_TABLES, type DumpRow } from "./types";

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
/** Mutations a member may make a minute. */
const MEMBER_CALLS_PER_MINUTE = 30;
/** Mutations visitors may make a minute: per address, and for the whole site. */
const VISITOR_CALLS = { address: 20, site: 300 };
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
/** Wrong passwords one key accepts an hour (checkPassword). */
const PASSWORD_FAILURES_PER_HOUR = 10;

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
   * a member's whose ticket it checked, for its live queries. It hibernates
   * between messages, so an idle one costs nothing.
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
    const pair = new WebSocketPair();
    const socket: LiveSocket = {
      id: randomUUID(),
      member,
      site: request.headers.get("X-Naru-Site") ?? "",
      clientIp: request.headers.get("X-Naru-Client-Ip") ?? undefined,
    };
    this.ctx.acceptWebSocket(pair[1], [
      "live",
      `socket:${socket.id}`,
      ...(member ? [`member:${member}`] : []),
    ]);
    pair[1].serializeAttachment(socket);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * A live query (1.1.0): `{ type: "subscribe", id, query, args }` runs the
   * query now, as the socket's member or a visitor, and again whenever a
   * write changes a table it read, sending `{ type: "result", id, result }`
   * when the answer changed (or `{ type: "error", id, error }`).
   * `{ type: "unsubscribe", id }` ends it. "ping" is answered without
   * reaching here.
   */
  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string" || data.length > 32 * 1024) return;
    let message: {
      type?: unknown;
      id?: unknown;
      query?: unknown;
      args?: unknown;
    };
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const me = socket.deserializeAttachment() as LiveSocket | null;
    const id = message?.id;
    if (!me || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
      return;
    if (message.type === "unsubscribe") {
      this.sql.exec(
        "DELETE FROM _naru_subscriptions WHERE socket = ? AND id = ?",
        me.id,
        id,
      );
      return;
    }
    if (message.type !== "subscribe") return;
    const refuse = (error: unknown) =>
      liveSend(socket, {
        type: "error",
        id,
        error:
          error instanceof DataError
            ? { status: error.status, message: error.message, code: error.code }
            : { status: 400, message: String(error) },
      });
    let file: string, fn: string;
    try {
      ({ file, fn } = functionReference(String(message.query)));
      const existing = this.rows(
        "SELECT id FROM _naru_subscriptions WHERE socket = ?",
        me.id,
      );
      if (
        existing.length >= MAX_SOCKET_SUBSCRIPTIONS &&
        !existing.some((row) => row.id === id)
      )
        throw new DataError(
          429,
          `A connection holds at most ${MAX_SOCKET_SUBSCRIPTIONS} live queries.`,
          "RATE_LIMITED",
        );
      if (
        Number(
          this.rows("SELECT count(*) AS n FROM _naru_subscriptions")[0].n,
        ) >= MAX_SITE_SUBSCRIPTIONS
      )
        throw new DataError(
          503,
          "The site holds as many live queries as it can.",
          "UNAVAILABLE",
        );
    } catch (error) {
      refuse(error);
      return;
    }
    const args = message.args ?? null;
    const outcome = await this.liveRun(me, file, fn, args, false);
    if (!outcome.ok) {
      liveSend(socket, { type: "error", id, error: outcome.error });
      return;
    }
    this.sql.exec(
      `INSERT INTO _naru_subscriptions (socket, id, member, query, args, tables, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (socket, id) DO UPDATE SET query = excluded.query, args = excluded.args,
         tables = excluded.tables, hash = excluded.hash`,
      me.id,
      id,
      me.member,
      `${file}:${fn}`,
      JSON.stringify(args),
      JSON.stringify(outcome.value.tables),
      outcome.value.hash,
    );
    liveSend(socket, { type: "result", id, result: outcome.value.result });
  }

  async webSocketClose(socket: WebSocket, code: number) {
    const me = socket.deserializeAttachment() as LiveSocket | null;
    if (me)
      this.sql.exec("DELETE FROM _naru_subscriptions WHERE socket = ?", me.id);
    // 1005 (no code) and 1006 (dropped) are only ever received, never sent.
    socket.close(code === 1005 || code === 1006 ? 1000 : code);
  }

  /**
   * Runs a live query as `me`: a subscription's first run is a query call
   * like any other, counted and limited; a re-run after a write is the
   * site's doing and only metered. Answers what it returned, the tables it
   * read (["*"] when it read a view, which could be any), and a hash of the
   * answer to tell whether it changed.
   */
  private async liveRun(
    me: LiveSocket,
    file: string,
    fn: string,
    args: unknown,
    refresh: boolean,
  ): Promise<Outcome<{ result: unknown; tables: string[]; hash: string }>> {
    const ownerId = this.meta("owner_id");
    if (!ownerId)
      return {
        ok: false,
        error: {
          status: 503,
          message: "Live queries are unavailable.",
          code: "UNAVAILABLE",
        },
      };
    const outcome = await this.call({
      ownerId,
      site: me.site,
      member: me.member,
      ...(me.member ? {} : { visitor: true }),
      clientIp: me.clientIp,
      file,
      name: fn,
      args,
      kind: "query",
      live: refresh ? "refresh" : "subscribe",
    });
    if (!outcome.ok) return outcome;
    const read = outcome.value.tables ?? [];
    const views = new Set(
      this.rows("SELECT name FROM sqlite_master WHERE type = 'view'").map(
        (row) => String(row.name).toLowerCase(),
      ),
    );
    return {
      ok: true,
      value: {
        result: outcome.value.result,
        tables: read.some((table) => views.has(table)) ? ["*"] : read,
        hash: createHash("sha256")
          .update(JSON.stringify(outcome.value.result) ?? "null")
          .digest("base64url"),
      },
    };
  }

  /** Tables written since the last refresh, re-run together on the next turn. */
  private refreshing?: Set<string>;
  private scheduleRefresh(tables: Iterable<string>) {
    const scheduled = this.refreshing !== undefined;
    this.refreshing ??= new Set();
    for (const table of tables) this.refreshing.add(table);
    if (!scheduled) setTimeout(() => void this.refresh(), 0);
  }

  /**
   * Re-runs the live queries that read a table written since the last
   * refresh ("*": all of them), once for each query, arguments and member
   * that share it, and sends each subscription a changed answer.
   */
  private async refresh() {
    const written = this.refreshing ?? new Set<string>();
    this.refreshing = undefined;
    const groups = new Map<string, Row[]>();
    for (const row of this.rows("SELECT * FROM _naru_subscriptions")) {
      const tables = JSON.parse(String(row.tables)) as string[];
      if (
        !written.has("*") &&
        !tables.includes("*") &&
        !tables.some((table) => written.has(table))
      )
        continue;
      if (!this.ctx.getWebSockets(`socket:${row.socket}`).length) {
        this.sql.exec(
          "DELETE FROM _naru_subscriptions WHERE socket = ?",
          row.socket,
        );
        continue;
      }
      const key = JSON.stringify([row.query, row.args, row.member]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    let runs = 0;
    for (const rows of groups.values()) {
      if (++runs > MAX_REFRESH_RUNS) break;
      const first = rows[0];
      const socket = this.ctx.getWebSockets(`socket:${first.socket}`)[0];
      const me = socket?.deserializeAttachment() as LiveSocket | null;
      if (!me) continue;
      const [file, fn] = String(first.query).split(":");
      this.tally("live_refresh");
      const outcome = await this.liveRun(
        me,
        file,
        fn,
        JSON.parse(String(first.args)),
        true,
      );
      const hash = outcome.ok
        ? outcome.value.hash
        : `error:${outcome.error.message}`;
      for (const row of rows) {
        if (row.hash === hash) continue;
        this.sql.exec(
          "UPDATE _naru_subscriptions SET hash = ?, tables = ? WHERE socket = ? AND id = ?",
          hash,
          outcome.ok ? JSON.stringify(outcome.value.tables) : row.tables,
          row.socket,
          row.id,
        );
        for (const target of this.ctx.getWebSockets(`socket:${row.socket}`))
          liveSend(
            target,
            outcome.ok
              ? { type: "result", id: row.id, result: outcome.value.result }
              : { type: "error", id: row.id, error: outcome.error },
          );
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
    // A document's write secret, from an early 1.1.0 that has since gone:
    // nothing reads or writes it now. Kept, so every object's documents have
    // the same columns (dumps, standby fingerprints).
    if (
      !this.rows("PRAGMA table_info(documents)").some(
        (column) => column.name === "secret_hash",
      )
    )
      this.sql.exec("ALTER TABLE documents ADD COLUMN secret_hash TEXT");
    // Every upload's references are tracked now, and functions no longer
    // delete uploads (ctx.media.delete): the tables for both go.
    this.sql.exec("DROP TABLE IF EXISTS managed_media");
    this.sql.exec("DROP TABLE IF EXISTS media_releases");
    this.sql.exec(USAGE_SCHEMA);
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
    const unique = this.uniqueFields(id);
    const indexes = this.indexFields(id);
    return {
      id,
      user_id: this.meta("owner_id"),
      ...row,
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

  /**
   * Wrong passwords a key (ctx.passwords.verify's: the post a password
   * opens, say) allows an hour, counted in memory: a failed call rolls its
   * transaction back, so a stored count would be undone by the very guess it
   * counts. A four-digit PIN then takes about a thousand hours to guess,
   * however many calls the guesses are spread over (a call checks three).
   */
  private passwordFailures = new Map<string, { hour: number; count: number }>();
  private checkPassword(key: string, password: string, hash: string) {
    const hour = Math.floor(Date.now() / 3600000);
    if (this.passwordFailures.size > 10000)
      for (const [key, entry] of this.passwordFailures)
        if (entry.hour !== hour) this.passwordFailures.delete(key);
    const entry = this.passwordFailures.get(key);
    const failures = entry?.hour === hour ? entry.count : 0;
    if (failures >= PASSWORD_FAILURES_PER_HOUR)
      throw new DataError(
        429,
        "Too many wrong passwords for this. Try again later.",
        "RATE_LIMITED",
      );
    const matches = verifyPassword(password, hash) === true;
    if (!matches) this.passwordFailures.set(key, { hour, count: failures + 1 });
    return matches;
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

  /** A member's mutations a minute, in fixed-minute buckets like visitors'. */
  private limitMember(member: string) {
    const window = Math.floor(Date.now() / 60000) * 60000;
    this.sql.exec("DELETE FROM rate_limits WHERE window_start < ?", window);
    const key = `call:${member}`;
    const count = Number(
      this.rows("SELECT count FROM rate_limits WHERE key = ?", key)[0]?.count ??
        0,
    );
    if (count >= MEMBER_CALLS_PER_MINUTE)
      throw new DataError(
        429,
        "Member call rate limit reached. Try again next minute.",
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
   * Writes a document. Its author (`created_by`) is no one's now: members
   * once wrote documents, and those keep theirs.
   */
  private upsert(
    collectionId: string,
    id: string,
    encoded: string,
    size: number,
  ) {
    this.trackMedia(collectionId, id, encoded);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO documents (collection_id, id, data, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (collection_id, id) DO UPDATE SET data = excluded.data,
         size_bytes = excluded.size_bytes, updated_at = excluded.updated_at,
         version = documents.version + 1`,
      collectionId,
      id,
      encoded,
      size,
      now,
      now,
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
    // Only the site's owner is free of the budget.
    const counted = input.access.anonymous;
    if (counted) {
      const spent = this.run(() => {
        this.admitWork();
        if (input.method === "GET") this.limitReader(callerKey(input.clientIp));
        this.spend(input.method === "GET" ? "visitor_read" : "visitor_write");
      });
      if (!spent.ok) return spent;
    }
    return this.run(() =>
      counted
        ? this.metered(() => this.executeSync(input))
        : this.executeSync(input),
    );
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
    return this.run(() => {
      if (input.path.length > 2) throw new DataError(404, "Not found.");
      input.path.forEach(name);
      return this.metered(() => this.executeSync(command));
    });
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

  private executeSync(input: ExecuteInput) {
    const { path, method, access } = input;
    const body = input.body ?? {};
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
    if (method === "GET") {
      const level = collection.read_access;
      if (!(admin || level === "world"))
        throw new DataError(
          403,
          `Collection ${collection.name} is not publicly readable. Change its read access in the control panel, or sign in.`,
        );
      // Identical rows for any stranger, so a shared cache may hold them.
      publicRead = level === "world" && access.anonymous;
      if (path.length === 2) {
        const row = this.rows(
          "SELECT id, data, version, created_at, updated_at, created_by FROM documents WHERE collection_id = ? AND id = ?",
          collection.id,
          path[1],
        )[0];
        if (!row) throw new DataError(404, "Document not found.");
        return { result: { document: documentOf(row) }, publicRead };
      }
      return { result: this.list(collection, input), publicRead };
    }
    const creating = method === "POST" && path.length === 1;
    const level = collection.write_access;
    // Adding is open to anyone in `create`; replacing and deleting there is
    // the owner's.
    if (!(admin || level === "world" || (level === "create" && creating)))
      throw new DataError(
        403,
        creating
          ? `Visitors cannot add to collection ${collection.name}. Change its write access in the control panel, or sign in.`
          : `Only a signed-in owner can change documents in collection ${collection.name}.`,
      );
    // Every write past this point is reachable without an owner credential
    // when the collection allows it, so all of them are counted.
    if (!admin) this.limitPublicWrite(input.clientIp);
    const expected = expectedVersion(input.ifVersion);
    const current = (id: string) =>
      this.rows(
        "SELECT size_bytes, version FROM documents WHERE collection_id = ? AND id = ?",
        collection.id,
        id,
      )[0] as { size_bytes: number; version: number } | undefined;
    if (method === "DELETE" && path.length === 2) {
      deletable(expected);
      const existing = current(path[1]);
      if (expected !== undefined) matchVersion(expected, existing?.version);
      // A missing document is already gone, as it is for the owner.
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
    const { encoded, size } = encode(body.data);
    this.checkQuota(existing?.size_bytes, size);
    // Never overwrite on create, even in the event of an ID collision.
    if (creating && existing)
      throw new DataError(
        409,
        "Document ID collision. Retry creation.",
        "CONFLICT",
      );
    this.checkUnique(collection, id, body.data);
    this.upsert(collection.id, id, encoded, size);
    return { result: { id, ...this.written(collection.id, id) }, publicRead };
  }

  /**
   * One statement of site SQL (ctx.sql, 1.1.0) against the site's own tables:
   * checked (sql.ts), held to its plan, and run in the call's transaction.
   * Returns its rows, at most MAX_ROWS of them and MAX_ROW_BYTES as JSON,
   * and how many rows it changed.
   */
  private siteSql(
    text: unknown,
    values: unknown,
    readonly: boolean,
    budget: { rowsRead: number; tables: SqlTables },
  ) {
    if (typeof text !== "string" || text.length > 64 * 1024)
      throw new DataError(400, "ctx.sql takes a statement of at most 64 KiB.");
    const parsed = statements(text);
    if (parsed.length !== 1)
      throw new DataError(400, "ctx.sql runs one statement at a time.");
    const seen: Tables = { tables: new Set() };
    const kind = classify(
      parsed[0].tokens,
      readonly ? ["read"] : ["read", "write"],
      seen,
    );
    // What live queries read, and what a write changes for them.
    if (kind === "read")
      for (const table of seen.tables) budget.tables.read.add(table);
    else
      for (const table of seen.target ? [seen.target] : seen.tables)
        budget.tables.written.add(table);
    const bound = bindings(values ?? []);
    const rows: Record<string, SqlValue>[] = [];
    let bytes = 0;
    let cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
    try {
      checkPlan(
        this.rows(
          `EXPLAIN QUERY PLAN ${text}`,
          ...bound,
        ) as unknown as PlanStep[],
      );
      cursor = this.sql.exec(text, ...bound);
      for (const row of cursor) {
        for (const value of Object.values(row))
          if (value instanceof ArrayBuffer)
            throw new DataError(
              400,
              "ctx.sql does not return BLOB values yet.",
            );
        bytes += JSON.stringify(row).length;
        rows.push(row as Record<string, SqlValue>);
        if (rows.length > MAX_ROWS || bytes > MAX_ROW_BYTES)
          throw new DataError(
            400,
            `ctx.sql returns at most ${MAX_ROWS} rows and 1 MiB; add a LIMIT.`,
          );
      }
    } catch (error) {
      throw sqlFailure(error);
    }
    // Each statement is held to one pass by its plan; a call, to a few.
    budget.rowsRead += cursor.rowsRead;
    if (budget.rowsRead > MAX_ROWS_READ)
      throw new DataError(
        400,
        `A call reads at most ${MAX_ROWS_READ.toLocaleString("en")} rows; read less, or by an index.`,
      );
    if (kind === "write") this.checkDatabaseSize();
    return { rows, changes: kind === "write" ? cursor.rowsWritten : 0 };
  }

  /** The whole database, collections and tables, within the site's quota. */
  private checkDatabaseSize() {
    if (this.sql.databaseSize > MAX_SITE_BYTES)
      throw new DataError(
        409,
        "Site database quota exceeded.",
        "QUOTA_EXCEEDED",
      );
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

  private functionRevisions: FunctionRevisions | undefined;
  private revisions(site: string) {
    return (this.functionRevisions ??= new FunctionRevisions(
      this.env.SITE_FILES,
      site,
    ));
  }

  /**
   * Activation only: snapshots and retirement tasks belong to the control
   * plane. A release's pending migrations (1.1.0) are applied in the same
   * transaction that switches to its code, after a restore point is kept in
   * R2; one that fails refuses the release (422) and changes nothing.
   */
  async activateFunctions(input: {
    revision: string;
    generation: string;
    /** The site, for its restore point; with the release's migrations. */
    site?: string;
    migrations?: Migration[];
  }) {
    if (
      !/^[a-f0-9]{64}$/.test(input.revision) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        input.generation,
      )
    )
      return this.run(() => {
        throw new DataError(400, "Invalid function release.");
      });
    // An older durable task must never reactivate code retired by a newer release.
    const newer = () => {
      const current = this.meta("functions_generation");
      return !current || input.generation > current;
    };
    const migrations = input.migrations ?? [];
    if (
      !Array.isArray(migrations) ||
      migrations.some(
        (m) =>
          typeof m?.name !== "string" ||
          !/^[A-Za-z0-9_.-]{1,128}\.sql$/.test(m.name) ||
          typeof m.sql !== "string" ||
          !/^[a-f0-9]{64}$/.test(m.digest),
      ) ||
      (migrations.length && !input.site)
    )
      return this.run(() => {
        throw new DataError(400, "Invalid function release.");
      });
    if (newer() && migrations.length) {
      const pending = this.run(() => this.pendingMigrations(migrations));
      if (!pending.ok) return pending;
      if (pending.value.length) {
        const dump = await this.dump();
        if (!dump.ok) return dump;
        await this.env.SITE_FILES.put(
          `_naru-runtime/${input.site}/restore-points/${input.generation}.json`,
          JSON.stringify(dump.value),
        );
      }
    }
    const activated = this.run(() => {
      const switching = newer();
      if (switching) {
        for (const migration of this.pendingMigrations(migrations))
          this.applyMigration(migration, input.generation);
        this.setMeta("functions_revision", input.revision);
        this.setMeta("functions_generation", input.generation);
      }
      return { revision: this.meta("functions_revision"), switching };
    });
    if (!activated.ok) return activated;
    // New code may answer live queries differently: every one runs again.
    if (activated.value.switching) this.scheduleRefresh(["*"]);
    return { ok: true, value: { revision: activated.value.revision } };
  }

  /**
   * The migrations of a release not yet applied, in order. Refuses a release
   * that edits or drops one already applied, or names a new one before it:
   * what has run is history, and a fix is a new file.
   */
  private pendingMigrations(migrations: Migration[]) {
    const applied = new Map(
      this.rows("SELECT name, digest FROM _naru_migrations").map((row) => [
        String(row.name),
        String(row.digest),
      ]),
    );
    const refuse = (name: string, reason: string) =>
      new DataError(422, `Migration ${name} ${reason}`, "INVALID_REQUEST", {
        reason: "migration_failed",
        migration: name,
      });
    const given = new Map(migrations.map((m) => [m.name, m]));
    for (const [name, digest] of applied) {
      if (!given.has(name))
        throw refuse(name, "has been applied and cannot be removed.");
      if (given.get(name)!.digest !== digest)
        throw refuse(
          name,
          "has been applied and cannot be changed; add a new migration instead.",
        );
    }
    const last = [...applied.keys()].sort().at(-1);
    const pending = migrations.filter((m) => !applied.has(m.name));
    for (const migration of pending)
      if (last !== undefined && migration.name < last)
        throw refuse(
          migration.name,
          `sorts before ${last}, which has been applied; name it to come after.`,
        );
    return pending;
  }

  /** Runs one migration's statements and records it, inside the caller's transaction. */
  private applyMigration(migration: Migration, generation: string) {
    const fail = (reason: string) =>
      new DataError(
        422,
        `Migration ${migration.name} failed: ${reason}`,
        "INVALID_REQUEST",
        { reason: "migration_failed", migration: migration.name },
      );
    try {
      for (const statement of statements(migration.sql)) {
        const kind = classify(statement.tokens, ["write", "schema"]);
        if (kind === "write")
          checkPlan(
            this.rows(
              `EXPLAIN QUERY PLAN ${statement.text}`,
            ) as unknown as PlanStep[],
          );
        this.sql.exec(statement.text);
      }
    } catch (error) {
      throw fail(
        error instanceof DataError
          ? error.message
          : String((error as Error)?.message ?? error),
      );
    }
    this.sql.exec(
      "INSERT INTO _naru_migrations (name, digest, applied_at, generation) VALUES (?, ?, ?, ?)",
      migration.name,
      migration.digest,
      Date.now(),
      generation,
    );
    this.checkDatabaseSize();
  }

  /**
   * Members' roles (1.1.0): names the site gives its members, kept with its
   * data so its code reads them in every call (`ctx.member.roles`,
   * `ctx.rolesOf`) and grants them (`ctx.setRoles`), and the owner edits them
   * on the control panel. A member without any has none on record.
   */
  private memberRoles(ids: unknown): Record<string, string[]> {
    if (!Array.isArray(ids) || ids.length > 100)
      throw new DataError(400, "rolesOf takes at most 100 member IDs.");
    const members = [...new Set(ids.map(name))];
    if (!members.length) return {};
    const found = new Map(
      this.rows(
        `SELECT member, roles FROM _naru_roles WHERE member IN (${members.map(() => "?").join(",")})`,
        ...members,
      ).map((row) => [String(row.member), JSON.parse(String(row.roles))]),
    );
    return Object.fromEntries(
      members.map((member) => [member, found.get(member) ?? []]),
    );
  }

  /** Replaces a member's roles: at most 16 distinct names, none to clear. */
  private setRoles(member: unknown, roles: unknown) {
    const id = name(member);
    if (!Array.isArray(roles) || roles.length > 16)
      throw new DataError(400, "A member has at most 16 roles.");
    const names = [...new Set(roles.map(name))].sort();
    if (names.length)
      this.sql.exec(
        "INSERT INTO _naru_roles (member, roles, updated_at) VALUES (?, ?, ?) ON CONFLICT (member) DO UPDATE SET roles = excluded.roles, updated_at = excluded.updated_at",
        id,
        JSON.stringify(names),
        Date.now(),
      );
    else this.sql.exec("DELETE FROM _naru_roles WHERE member = ?", id);
  }

  /** The control panel's view of members' roles. */
  async rolesOfMembers(input: { ids: unknown }) {
    return this.run(() => this.memberRoles(input.ids));
  }

  /** The owner sets a member's roles on the control panel. */
  async setMemberRoles(input: { member: unknown; roles: unknown }) {
    return this.run(() => {
      this.setRoles(input.member, input.roles);
      return this.memberRoles([input.member])[String(input.member)];
    });
  }

  /** The site's own tables and views with their columns, for naru-dev's types. */
  async siteTables() {
    return this.run(() =>
      this.siteObjects()
        .filter((object) => object.type !== "index")
        .map((object) => ({
          name: object.name,
          view: object.type === "view",
          columns: this.rows(
            'SELECT name, type, "notnull", pk FROM pragma_table_info(?)',
            object.name,
          ).map((column) => ({
            name: String(column.name),
            type: String(column.type),
            nullable: Number(column.notnull) === 0 && Number(column.pk) === 0,
          })),
        })),
    );
  }

  /**
   * The site's own tables, indexes and views, as sqlite_master has them, in
   * the order they can be created again: tables, then indexes, then views.
   */
  private siteObjects() {
    const order: Record<string, number> = { table: 0, index: 1, view: 2 };
    return this.rows(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index', 'view') ORDER BY rowid",
    )
      .filter((row) => !reserved(String(row.name)))
      .sort((a, b) => order[String(a.type)] - order[String(b.type)])
      .map((row) => ({
        type: String(row.type),
        name: String(row.name),
        sql: String(row.sql),
      }));
  }

  /**
   * Test fixture and naru-dev only: production snapshots are created in the
   * control plane. Activates what it publishes, migrations included.
   */
  private async publishFunctions(input: { site: string }) {
    let revision: string;
    try {
      revision = await this.revisions(input.site).publish();
    } catch (error) {
      return this.run(() => {
        throw error;
      });
    }
    let migrations: Migration[];
    try {
      migrations = await this.revisions(input.site).migrations(revision);
    } catch (error) {
      return this.run(() => {
        throw error;
      });
    }
    return this.activateFunctions({
      revision,
      generation: uuidv7(),
      site: input.site,
      migrations,
    });
  }

  /**
   * What site code's ctx may do, in this call's transaction: run site SQL,
   * read and grant members' roles, and hash and check passwords. `tables`
   * gathers the tables its SQL read and wrote, for live queries.
   */
  private siteHost(
    tables: SqlTables = { read: new Set(), written: new Set() },
  ): Host {
    const sqlBudget = { rowsRead: 0, tables };
    return (operation, args) => {
      switch (operation) {
        case "random":
          return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
        case "rolesOf":
          return this.memberRoles(args[0]);
        case "setRoles":
          this.setRoles(args[0], args[1]);
          return null;
        case "sql":
          // [text, values, read-only], the last from the call, not the code.
          return this.siteSql(args[0], args[1], args[2] === true, sqlBudget);
        case "passwordHash": {
          const password = args[0];
          if (
            typeof password !== "string" ||
            password.length < 1 ||
            password.length > 256
          )
            throw new DataError(400, "A password is 1–256 characters.");
          return hashPassword(password);
        }
        case "passwordVerify": {
          // [password, hash, key]: ten wrong guesses an hour for each key,
          // such as the post the password opens, whoever guesses.
          const [password, hash, key] = args;
          if (
            typeof password !== "string" ||
            typeof hash !== "string" ||
            typeof key !== "string" ||
            !key ||
            key.length > 256
          )
            throw new DataError(
              400,
              "ctx.passwords.verify takes a password, its hash and a key.",
            );
          return this.checkPassword(`passwords/${key}`, password, hash);
        }
        default:
          throw new DataError(400, `ctx has no ${operation}.`);
      }
    };
  }

  /**
   * A member, the site's owner (`member` null), or a visitor calls one of the
   * site's queries or mutations, or a route renders: an export of
   * `_naru/queries/`, `_naru/mutations/` or `_naru/routes/`. A query or
   * route only reads, and counts as a read; a mutation counts against the
   * member's or visitor's calls. A member's or visitor's call is counted
   * against the month first, on its own: a call that then fails was still
   * made. The owner's are never counted. The code runs in one transaction; a
   * failure rolls it back.
   */
  async call(input: {
    ownerId: string;
    site: string;
    member: string | null;
    /** No one signed in. */
    visitor?: boolean;
    /**
     * Only queries and routes may run: this copy is the standby, answering
     * while the mini is away, and must not change.
     */
    readOnlyOnly?: boolean;
    /** A visitor's address, which their calls are limited by. */
    clientIp?: string;
    /** The module, as `<module/path>` under its kind's folder. */
    file: string;
    name: string;
    args: unknown;
    kind: "query" | "mutation" | "route";
    /**
     * A live query's run (internal): its answer says the tables it read,
     * and a re-run after a write ("refresh") is not counted as a call.
     */
    live?: "subscribe" | "refresh";
  }): Promise<Outcome<{ result: unknown; tables?: string[] }>> {
    const visitor = input.member === null && input.visitor === true;
    const kind = input.kind;
    const readonly = kind === "query" || kind === "route";
    let filename: string, sources;
    try {
      if (!["query", "mutation", "route"].includes(kind))
        throw new DataError(400, "Invalid call.");
      if (kind === "route") routeModule(input.file);
      else functionModule(input.file);
      name(input.name);
      if (input.readOnlyOnly && !readonly) throw readOnlyStandby();
      const revision = this.meta("functions_revision");
      if (!revision) throw unpublished();
      const revisions = this.revisions(input.site);
      const folder = {
        query: "queries",
        mutation: "mutations",
        route: "routes",
      }[kind];
      filename = await revisions.entry(revision, `${folder}/${input.file}`);
      sources = await revisions.graph(revision, filename);
    } catch (error) {
      if (error instanceof DataError)
        return this.run(() => {
          throw error;
        });
      throw error;
    }
    const admitted = this.run(() => {
      this.claim(input.ownerId);
      if (input.live === "refresh") return;
      if (visitor || input.member !== null) this.admitWork();
      // A query or a route's page replaces a page's reads, so it is limited
      // as reads are: 600 a minute per member or address.
      if (readonly && (visitor || input.member)) {
        this.spend(visitor ? "visitor_query" : "member_query");
        this.limitReader(
          visitor ? callerKey(input.clientIp) : `member:${input.member}`,
        );
        return;
      }
      if (visitor) {
        this.spend("visitor_call");
        this.limitVisitor(input.clientIp);
        return;
      }
      if (input.member === null) return;
      this.spend("member_call");
      this.limitMember(input.member);
    });
    if (!admitted.ok) return admitted;
    const engine = await quickjs();
    const tables: SqlTables = { read: new Set(), written: new Set() };
    try {
      const counted =
        input.live !== "refresh" && (visitor || input.member !== null);
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
              kind,
              roles:
                input.member === null
                  ? []
                  : (this.memberRoles([input.member])[input.member] ?? []),
            },
            this.siteHost(tables),
          ),
        ),
        ...(input.live ? { tables: [...tables.read].sort() } : {}),
      }));
      if (outcome.ok && tables.written.size)
        this.scheduleRefresh(tables.written);
      return outcome;
    } catch (error) {
      // Not the code's doing: the engine itself failed. The call retired its
      // instance (functions.ts), and the next starts a new one.
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
   * A visitor's query or mutation at the edge (website.ts): answered here
   * only while the edge may answer the site's visitors, like `serve`;
   * otherwise the Worker sends it on to the control plane.
   */
  async visit(input: {
    site: string;
    file: string;
    name: string;
    args: unknown;
    clientIp?: string;
    readOnlyOnly?: boolean;
    kind: "query" | "mutation";
  }): Promise<Outcome<{ pass: true } | { pass?: undefined; result: unknown }>> {
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
    return { ok: true, value: { result: outcome.value.result } };
  }

  /**
   * A route's page (1.1.0), for the edge Worker serving the site (pages.ts):
   * its module's default export, run as a visitor's query with the path, its
   * parameters and the query string. Refused (503) while the edge may not
   * answer the site's visitors, as `visit` passes them on.
   */
  async render(input: {
    site: string;
    route: string;
    path: string;
    params: Record<string, string>;
    query: Record<string, string>;
    clientIp?: string;
  }): Promise<Outcome<{ result: unknown }>> {
    const ownerId = this.meta("owner_id");
    const until = this.meta("entitled_until");
    const now = Date.now();
    if (
      ownerId === null ||
      until === null ||
      Number(this.meta("confirmed_until") ?? 0) <= now ||
      (until !== "forever" && Number(until) <= now)
    )
      return {
        ok: false,
        error: {
          status: 503,
          message: "Routes are unavailable.",
          code: "UNAVAILABLE",
        },
      };
    const outcome = await this.call({
      ownerId,
      site: input.site,
      member: null,
      visitor: true,
      clientIp: input.clientIp,
      file: input.route,
      name: "default",
      args: {
        path: String(input.path),
        params: input.params ?? {},
        query: input.query ?? {},
      },
      kind: "route",
    });
    if (!outcome.ok) return outcome;
    return { ok: true, value: { result: outcome.value.result } };
  }

  /** A visitor's mutations a minute, by address and for the whole site. */
  private limitVisitor(clientIp: string | undefined) {
    const window = Math.floor(Date.now() / 60000) * 60000;
    this.sql.exec("DELETE FROM rate_limits WHERE window_start < ?", window);
    const kind = "visitor-call";
    const limits = VISITOR_CALLS;
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
   * Deletes a collection with its documents, unique fields, indexes and
   * upload references. Its uploads stay: media may be linked from anywhere.
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
    // Once a collection rule's module (`rules:<id>`, from an early 1.1.0).
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
   * The uploads a document's JSON names by address: the site's media URLs
   * end in `/<owner id>/<upload id>.<ext>`, in plain fields or inside HTML
   * alike. Every upload counts; an ID no upload has only marks nothing.
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
    return [...new Set([...encoded.matchAll(pattern)].map((m) => m[1]))];
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

  /**
   * Which of `ids` (uploads) a document uses, for the media library to mark
   * the others. Unreferenced uploads stay until deleted. References were
   * once kept only for uploads marked managed, and documents may name
   * uploads from before that (or from when UUID owners went unmatched): the
   * first answer records every document's references once.
   */
  async mediaReferences(input: { ids?: unknown }) {
    return this.run(() => {
      if (this.meta("media_refs") !== "all") {
        for (const document of this.rows(
          "SELECT collection_id, id, data FROM documents",
        ))
          this.trackMedia(
            document.collection_id as string,
            document.id as string,
            document.data as string,
          );
        this.setMeta("media_refs", "all");
      }
      const ids = Array.isArray(input.ids)
        ? input.ids
            .filter((id): id is string => typeof id === "string")
            .slice(0, 100)
        : [];
      const used = new Set(
        ids.filter(
          (id) =>
            this.rows(
              "SELECT 1 FROM media_refs WHERE upload_id = ? LIMIT 1",
              id,
            ).length > 0,
        ),
      );
      // The site's own tables (1.1.0) keep upload URLs in text columns,
      // which no reference is recorded for: searched for the rest.
      let rest = ids.filter((id) => !used.has(id));
      const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
      for (const table of this.siteObjects())
        if (table.type === "table")
          for (const column of this.rows(
            "SELECT name, type FROM pragma_table_info(?)",
            table.name,
          ))
            if (rest.length && /TEXT|CHAR|CLOB|^$/i.test(String(column.type))) {
              const col = quote(String(column.name));
              for (const row of this.rows(
                `SELECT ${col} AS v FROM ${quote(table.name)} WHERE ${rest.map(() => `instr(${col}, ?) > 0`).join(" OR ")} LIMIT 1000`,
                ...rest,
              ))
                for (const id of rest)
                  if (String(row.v).includes(id)) used.add(id);
              rest = rest.filter((id) => !used.has(id));
            }
      return ids.filter((id) => used.has(id));
    });
  }

  /** Tests only: replaces a module or migration, or removes it (null). */
  async putFunctions(input: {
    site: string;
    file: string;
    source: string | null;
    folder: "modules" | "migrations" | "queries" | "mutations" | "routes";
    /** False stores the file only, for a batch published by its last file. */
    publish?: boolean;
  }) {
    const folder = input.folder;
    if (
      !["modules", "migrations", "queries", "mutations", "routes"].includes(
        folder,
      )
    )
      return this.run(() => {
        throw new DataError(400, "Invalid folder.");
      });
    const key =
      folder === "migrations"
        ? `${input.site}/_naru/${migrationPath(`migrations/${input.file}.sql`)}`
        : `${input.site}/_naru/${folder}/${folder === "routes" ? routeModule(input.file) : functionModule(input.file)}.js`;
    if (input.source === null) await this.env.SITE_FILES.delete(key);
    else await this.env.SITE_FILES.put(key, input.source);
    if (input.publish === false) return { ok: true, value: null };
    const published = await this.publishFunctions({ site: input.site });
    if (!published.ok) return published;
    return { ok: true, value: null };
  }

  private list(collection: Collection, input: ListInput) {
    const query = listQuery(collection.id, input);
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
        this.upsert(collection.id, id, encoded, size);
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
      // With each one's unique and indexed fields, when it has them.
      return (
        input.names
          ? rows.filter((row) => input.names!.includes(row.name))
          : rows
      ).map((row) => {
        const unique = this.uniqueFields(row.id);
        const indexes = this.indexFields(row.id);
        return {
          ...row,
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
   * unique and indexed fields. Null when new ones would pass the
   * collection limit; a unique field documents already share fails it all.
   */
  async configureCollections(input: {
    ownerId: string;
    collections: (Omit<Collection, "id"> & {
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
        if (wanted.unique !== undefined) this.setUnique(row, wanted.unique);
        if (wanted.indexes !== undefined) this.setIndexes(row, wanted.indexes);
      }
      return missing.map((c) => c.name);
    });
  }

  async export(): Promise<Outcome<Snapshot>> {
    return this.run(() => ({
      ownerId: this.meta("owner_id"),
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
   * `restore`): collections, documents, upload references, limits and
   * settings, and the site's own tables.
   */
  async dump(): Promise<Outcome<Dump>> {
    return this.run(() => {
      const objects = this.siteObjects();
      return {
        tables: Object.fromEntries(
          DUMP_TABLES.map((table) => [
            table,
            this.rows(`SELECT * FROM ${table}`).map(dumpRow),
          ]),
        ) as Dump["tables"],
        site: {
          schema: objects.map((object) => object.sql),
          tables: Object.fromEntries(
            objects
              .filter((object) => object.type === "table")
              .map((object) => [
                object.name,
                this.rows(
                  `SELECT * FROM "${object.name.replaceAll('"', '""')}"`,
                ).map(dumpRow),
              ]),
          ),
          migrations: this.rows("SELECT * FROM _naru_migrations").map(dumpRow),
          roles: this.rows("SELECT * FROM _naru_roles").map(dumpRow),
        },
      };
    });
  }

  /**
   * Fills an empty site with another runtime's `dump`. Refused once the site
   * has a collection, so a mistaken run cannot overwrite live data.
   */
  async restore(input: Dump): Promise<Outcome<{ rows: number }>> {
    return this.run(() => {
      if (this.rows("SELECT 1 FROM collections LIMIT 1").length)
        throw new DataError(409, "The site already has collections.");
      if (this.siteObjects().length)
        throw new DataError(409, "The site already has tables.");
      return this.fill(input);
    });
  }

  /** Writes a `dump` into tables `restore` or `replace` emptied. */
  private fill(input: Dump) {
    let rows = this.fillSite(input.site);
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
          ...present.map((column) => fromDump(row[column])),
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

  /**
   * Replaces the site's own tables with a dump's: what it held is dropped,
   * the dump's schema created (checked as a migration's is) and its rows
   * written. Returns how many rows were written.
   */
  private fillSite(site: Dump["site"]) {
    for (const object of this.siteObjects().reverse())
      this.sql.exec(
        `DROP ${object.type.toUpperCase()} IF EXISTS "${object.name.replaceAll('"', '""')}"`,
      );
    this.sql.exec("DELETE FROM _naru_migrations");
    this.sql.exec("DELETE FROM _naru_roles");
    if (!site) return 0;
    let rows = 0;
    for (const sql of site.schema) {
      for (const statement of statements(sql))
        classify(statement.tokens, ["schema"]);
      this.sql.exec(sql);
    }
    const insert = (table: string, given: DumpRow[]) => {
      const columns = this.rows(
        `SELECT name FROM pragma_table_info(?)`,
        table,
      ).map((column) => String(column.name));
      for (const row of given) {
        const present = columns.filter((column) => Object.hasOwn(row, column));
        const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
        this.sql.exec(
          `INSERT INTO ${quote(table)} (${present.map(quote).join(", ")}) VALUES (${present.map(() => "?").join(", ")})`,
          ...present.map((column) => fromDump(row[column])),
        );
        rows++;
      }
    };
    for (const [table, given] of Object.entries(site.tables ?? {})) {
      if (reserved(table) || !Array.isArray(given))
        throw new DataError(
          400,
          `The dump's table ${table} is not the site's.`,
        );
      insert(table, given);
    }
    insert("_naru_migrations", site.migrations ?? []);
    insert("_naru_roles", site.roles ?? []);
    return rows;
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
