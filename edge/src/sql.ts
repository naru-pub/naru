import { DataError } from "../../control-plane/src/lib/site-data/validation";
import type { SqlValue } from "./query";

// Site SQL (1.1.0): the statements site code runs against its own tables
// (ctx.sql) and the migrations a release applies (_naru/migrations/). Naru's
// own tables share the site's SQLite database, so SQL names only the site's:
// anything naming one of Naru's, or doing what is Naru's to do (pragmas,
// attaching, triggers, transactions), is refused before it runs.
//
// SQLite's time is outside the fuel meter (engine.ts), and the mini's runtime
// has no CPU limit, so Naru's workerd on the mini stops any one step of a
// statement after 3 seconds (seoul/workerd/, `interrupted` below), and a
// statement stopped again and again is paused (breaker.ts).

/**
 * Naru's own tables, indexes and triggers in the site's database; a test keeps
 * this in step with the schema. Anything Naru adds from now on is named
 * `_naru_...`, which the site's SQL cannot name.
 */
export const INTERNAL = new Set([
  "meta",
  "collections",
  "documents",
  "documents_created",
  "documents_updated",
  "media_refs",
  "media_refs_upload",
  "rate_limits",
  "usage",
  "usage_insert",
  "usage_delete",
  "usage_update",
]);
/**
 * Naru's views that site SQL may read, never write or build on (query.ts):
 * members' roles and the site's uploads, to join with the site's tables.
 */
export const READABLE = new Set(["_naru_member_roles", "_naru_uploads"]);
/** A collection field's index (query.ts, site.ts). */
const INTERNAL_PREFIXES = ["documents_index_", "documents_unique_"];

/** Whether `name` is Naru's, not the site's to use. */
export function reserved(name: string) {
  const lower = name.toLowerCase();
  return (
    INTERNAL.has(lower) ||
    INTERNAL_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    lower.startsWith("_naru") ||
    // The runtime's own: Durable Objects' key-value storage (_cf_KV) and
    // the local runtime's object name.
    lower.startsWith("_cf_") ||
    lower.startsWith("__miniflare") ||
    lower.startsWith("sqlite_") ||
    lower.startsWith("pragma_")
  );
}

type Token =
  | { kind: "word"; text: string; upper: string }
  | { kind: "name"; text: string } // a quoted identifier
  | { kind: "string"; text: string }
  | { kind: "other"; text: string };

const invalid = (message: string) =>
  new DataError(400, `Invalid SQL: ${message}`, "INVALID_REQUEST");

/** A statement: its tokens, without whitespace or comments, and its text. */
export type Statement = { tokens: Token[]; text: string };

/** SQLite's statements in `sql`, split on semicolons outside quotes and comments. */
export function statements(sql: string): Statement[] {
  const out: Statement[] = [];
  let current: Token[] = [];
  let start = 0;
  let i = 0;
  const quoted = (close: string, kind: "name" | "string") => {
    let text = "";
    for (i++; ; i++) {
      if (i >= sql.length) throw invalid("an unclosed quote.");
      if (sql[i] === close) {
        if (close !== "]" && sql[i + 1] === close) {
          text += close;
          i++;
          continue;
        }
        i++;
        return { kind, text } as Token;
      }
      text += sql[i];
    }
  };
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) i++;
    else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw invalid("an unclosed comment.");
      i = end + 2;
    } else if (c === "'") current.push(quoted("'", "string"));
    else if (c === '"') current.push(quoted('"', "name"));
    else if (c === "`") current.push(quoted("`", "name"));
    else if (c === "[") current.push(quoted("]", "name"));
    else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j])) j++;
      const text = sql.slice(i, j);
      // X'..' is a blob literal.
      if (/^[xX]$/.test(text) && sql[j] === "'") {
        i = j;
        current.push(quoted("'", "string"));
      } else {
        current.push({ kind: "word", text, upper: text.toUpperCase() });
        i = j;
      }
    } else if (c === ";") {
      if (current.length)
        out.push({ tokens: current, text: sql.slice(start, i) });
      current = [];
      start = ++i;
    } else {
      current.push({ kind: "other", text: c });
      i++;
    }
  }
  if (current.length) out.push({ tokens: current, text: sql.slice(start) });
  return out;
}

/** The text of a name token, bare or quoted, or undefined. */
const nameOf = (token: Token | undefined) =>
  token?.kind === "word" || token?.kind === "name" ? token.text : undefined;
const is = (token: Token | undefined, ...words: string[]) =>
  token?.kind === "word" && words.includes(token.upper);
/** Whether `token` is the punctuation `c`, not a quoted name or string of it. */
const punct = (token: Token | undefined, c: string) =>
  token?.kind === "other" && token.text === c;

/** Words no site SQL may use, wherever they stand. */
const REFUSED = new Map([
  ["PRAGMA", "pragmas are Naru's"],
  ["ATTACH", "attaching databases is Naru's"],
  ["DETACH", "attaching databases is Naru's"],
  ["TRIGGER", "triggers are not supported"],
  ["RECURSIVE", "recursive queries are not supported"],
  ["ROLLBACK", "transactions are Naru's"],
  ["SAVEPOINT", "transactions are Naru's"],
  ["VACUUM", "VACUUM is Naru's"],
]);

/** Where a table's name follows: FROM a, b JOIN c, INTO d, UPDATE e, ... */
const BEFORE_TABLE = new Set([
  "FROM",
  "JOIN",
  "INTO",
  "UPDATE",
  "TABLE",
  "REFERENCES",
  "VIEW",
  "INDEX",
]);

/** Words that end a FROM list: what follows names no table of the list. */
const AFTER_FROM = [
  "WHERE",
  "GROUP",
  "ORDER",
  "LIMIT",
  "HAVING",
  "WINDOW",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "SET",
  "DO",
  "RETURNING",
];
/** UPDATE OR IGNORE t, INSERT OR REPLACE INTO t: the conflict a write names. */
const CONFLICTS = ["ROLLBACK", "ABORT", "REPLACE", "FAIL", "IGNORE"];

export type Kind = "read" | "write" | "schema";

/**
 * The tables a statement names, for live queries: every one, and the first
 * (a write's own table, unless a WITH comes before it).
 */
export type Tables = { tables: Set<string>; target?: string };

/**
 * What one statement is, refused unless `allowed` has its kind: `read`
 * (SELECT, VALUES), `write` (INSERT, REPLACE, UPDATE, DELETE) or `schema`
 * (CREATE, ALTER and DROP of tables, indexes and views; full-text tables
 * with fts5).
 */
export function classify(
  tokens: Token[],
  allowed: Kind[],
  seen?: Tables,
): Kind {
  /** One of Naru's views the statement names: read, never built on. */
  let readable: string | undefined;
  const refuse = (name: string | undefined) => {
    if (name !== undefined && READABLE.has(name.toLowerCase())) readable = name;
    else if (name !== undefined && reserved(name))
      throw invalid(`${name} is Naru's.`);
  };
  /** Checks the table named at `index` (name or schema.name); returns past it. */
  const table = (index: number) => {
    refuse(nameOf(tokens[index]));
    let name = nameOf(tokens[index]);
    let next = index + 1;
    if (punct(tokens[index + 1], ".")) {
      refuse(nameOf(tokens[index + 2]));
      name = nameOf(tokens[index + 2]);
      next = index + 3;
    }
    // ON CONFLICT DO UPDATE SET: no table follows.
    if (seen && name !== undefined && !is(tokens[index], "SET")) {
      seen.tables.add(name.toLowerCase());
      seen.target ??= name.toLowerCase();
    }
    return next;
  };
  /**
   * Checks the FROM list (or what follows a JOIN) from `start` to its end:
   * each table or table-valued function it names, after FROM, JOIN or a
   * comma at the list's own level (a comma inside an expression is always in
   * parentheses), and those of a parenthesized list, (a JOIN b). A
   * parenthesized subquery has its own FROM, met as the walk goes on.
   */
  const fromList = (start: number) => {
    let level = 0;
    let item = true;
    for (let index = start; index < tokens.length; index++) {
      const token = tokens[index];
      if (level === 0 && item) {
        item = false;
        if (!punct(token, "(")) table(index);
        else if (!is(tokens[index + 1], "SELECT", "VALUES", "WITH"))
          fromList(index + 1);
      }
      if (punct(token, "(")) level++;
      else if (punct(token, ")")) {
        if (--level < 0) return;
      } else if (level === 0) {
        if (punct(token, ",") || is(token, "JOIN")) item = true;
        else if (is(token, ...AFTER_FROM)) return;
      }
    }
  };
  const virtual = is(tokens[1], "VIRTUAL");
  const createsIndex =
    is(tokens[0], "CREATE") &&
    (is(tokens[1], "INDEX") ||
      (is(tokens[1], "UNIQUE") && is(tokens[2], "INDEX")));
  let indexed = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "word" && REFUSED.has(token.upper))
      throw invalid(`${REFUSED.get(token.upper)}.`);
    // A full-text table's options can name another table (content=...),
    // quoted or bare.
    if (virtual && (token.kind === "string" || token.kind === "name"))
      refuse(token.text);
    if (virtual && is(token, "CONTENT") && punct(tokens[index + 1], "="))
      refuse(nameOf(tokens[index + 2]));
    // a IS [NOT] DISTINCT FROM b compares; it names no table.
    if (is(token, "FROM") && is(tokens[index - 1], "DISTINCT")) continue;
    if (token.kind === "word" && BEFORE_TABLE.has(token.upper)) {
      let next = index + 1;
      for (;;) {
        if (is(tokens[next], "IF", "NOT", "EXISTS", "UNIQUE")) next++;
        else if (is(tokens[next], "OR") && is(tokens[next + 1], ...CONFLICTS))
          next += 2;
        else break;
      }
      if (is(token, "FROM", "JOIN")) fromList(next);
      else table(next);
      continue;
    }
    // CREATE [UNIQUE] INDEX [IF NOT EXISTS] [schema.]name ON table
    if (createsIndex && !indexed && is(token, "ON")) {
      indexed = true;
      table(index + 1);
    }
    // ALTER TABLE t RENAME TO name
    if (is(token, "TO") && is(tokens[index - 1], "RENAME")) table(index + 1);
  }
  const first = tokens[0];
  if (!first || first.kind !== "word") throw invalid("an empty statement.");
  let verb = first.upper;
  if (verb === "WITH") {
    // The statement a common table expression leads to.
    let level = 0;
    verb = "";
    for (const token of tokens.slice(1)) {
      if (punct(token, "(")) level++;
      else if (punct(token, ")")) level--;
      else if (
        level === 0 &&
        is(token, "SELECT", "INSERT", "REPLACE", "UPDATE", "DELETE", "VALUES")
      ) {
        verb = (token as { upper: string }).upper;
        break;
      }
    }
  }
  let kind: Kind | undefined;
  if (verb === "SELECT" || verb === "VALUES") kind = "read";
  else if (["INSERT", "REPLACE", "UPDATE", "DELETE"].includes(verb))
    kind = "write";
  else if (verb === "CREATE") {
    const rest = tokens.slice(1).filter((token) => !is(token, "UNIQUE"));
    if (is(rest[0], "TABLE", "INDEX", "VIEW")) kind = "schema";
    else if (is(rest[0], "VIRTUAL")) {
      // Full-text tables only (fts5): SQLite's other modules read files or
      // run code. One with no content of its own cannot be dumped, so a
      // site could not be moved or restored with it.
      const using = tokens.findIndex((token) => is(token, "USING"));
      if (!is(tokens[using + 1], "FTS5"))
        throw invalid("virtual tables are full-text (fts5) tables only.");
      tokens.forEach((token, index) => {
        if (
          is(token, "CONTENT", "CONTENTLESS_DELETE", "CONTENTLESS_UNINDEXED") &&
          tokens[index + 1]?.text === "=" &&
          (is(token, "CONTENTLESS_DELETE", "CONTENTLESS_UNINDEXED") ||
            tokens[index + 2]?.text === "")
        )
          throw invalid(
            "a full-text table keeps its content, or names the table it indexes.",
          );
      });
      kind = "schema";
    } else if (is(rest[0], "TEMP", "TEMPORARY"))
      throw invalid("temporary tables are not supported.");
  } else if (verb === "ALTER" && is(tokens[1], "TABLE")) kind = "schema";
  else if (verb === "DROP" && is(tokens[1], "TABLE", "INDEX", "VIEW"))
    kind = "schema";
  if (!kind) throw invalid(`${first.text} is not a statement site SQL runs.`);
  if (readable !== undefined && kind === "schema")
    throw invalid(
      `${readable} is Naru's: site SQL reads it, and builds nothing on it.`,
    );
  // A write after WITH may write any table it names.
  if (seen && first.upper === "WITH") seen.target = undefined;
  if (!allowed.includes(kind))
    throw invalid(
      kind === "schema"
        ? "schema changes belong in _naru/migrations/."
        : "a read-only query cannot write.",
    );
  return kind;
}

/** A statement's bound values: strings, finite numbers, booleans or null. */
export function bindings(values: unknown): SqlValue[] {
  if (!Array.isArray(values) || values.length > 100)
    throw invalid("at most 100 values are bound.");
  return values.map((value) => {
    if (value === null || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    // A Uint8Array, as ctx.sql sends it from the sandbox.
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { $blob?: unknown }).$blob === "string"
    ) {
      const bytes = Buffer.from((value as { $blob: string }).$blob, "base64");
      if (bytes.byteLength > MAX_ROW_BYTES)
        throw invalid("a BLOB value is at most 1 MiB.");
      return new Uint8Array(bytes).buffer;
    }
    throw invalid(
      "values are strings, finite numbers, booleans, Uint8Arrays or null.",
    );
  });
}

/** Rows a statement may return, and their size as JSON. */
export const MAX_ROWS = 1000;
export const MAX_ROW_BYTES = 1024 * 1024;
/**
 * Rows a call's statements may read in all: five passes over a full table.
 * Counted from each statement's cursor once it has finished (site.ts), so it
 * fails the call after the statement that passes it, never part way.
 */
export const MAX_ROWS_READ = 500_000;

/**
 * The mini's step budget, in ms, as the object's environment gives it
 * (SQLITE_STATEMENT_TIMEOUT_MS, from the WORKERD_SQLITE_STATEMENT_TIMEOUT_MS
 * that sets it in workerd: seoul/workerd/), or undefined where unknown.
 */
export function statementBudget(env: unknown) {
  const ms = Number(
    (env as { SQLITE_STATEMENT_TIMEOUT_MS?: string } | undefined)
      ?.SQLITE_STATEMENT_TIMEOUT_MS,
  );
  return ms > 0 ? ms : undefined;
}

/**
 * Whether `error` is SQLite stopping a statement at the runtime's step
 * budget: Naru's workerd on the mini interrupts any one step of a statement
 * that runs past it (seoul/workerd/README.md). An interrupted read throws
 * this in the object; an interrupted write rolls back the object's
 * transaction and resets the object, and its caller's stub throws it.
 */
export const interrupted = (error: unknown) =>
  /\bSQLITE_INTERRUPT\b/.test(String((error as Error)?.message ?? error));

const duration = (ms: number) =>
  ms % 1000 === 0 && ms >= 1000
    ? `${ms / 1000} second${ms === 1000 ? "" : "s"}`
    : `${ms} ms`;

/** A statement the runtime stopped at its step budget (`budgetMs`, when known). */
export function tooLong(budgetMs?: number) {
  return new DataError(
    400,
    budgetMs
      ? `This statement ran longer than ${duration(budgetMs)} and was stopped; give it an index or read less.`
      : "This statement ran too long and was stopped; give it an index or read less.",
    "INVALID_REQUEST",
  );
}

/**
 * A migration the runtime stopped at its step budget. Its write reset the
 * object, so which migration it was is not known: the release was refused
 * whole, and nothing it would have changed was.
 */
export function migrationTooLong(budgetMs?: number) {
  return new DataError(
    422,
    `A migration ran ${budgetMs ? `longer than ${duration(budgetMs)}` : "too long"} and was stopped, so the release changed nothing; give its statements an index or change less at a time.`,
    "INVALID_REQUEST",
    { reason: "migration_failed" },
  );
}

/**
 * What the object's caller tells of a stub that threw because the runtime
 * stopped a statement and reset the object (`interrupted`): a site's
 * statement (a call's, `migrations` for an activation) is its own to fix;
 * one of Naru's own, which are kept short, is the database being
 * unavailable. Anything else is undefined, for the caller's own handling.
 */
export function interruptedCall(
  error: unknown,
  env: unknown,
  statement: "site" | "migrations" | "naru",
) {
  if (!interrupted(error)) return undefined;
  const budget = statementBudget(env);
  if (statement === "site") return tooLong(budget);
  if (statement === "migrations") return migrationTooLong(budget);
  return new DataError(
    503,
    "The site database stopped a statement that ran too long. Try again shortly.",
    "UNAVAILABLE",
  );
}

/**
 * What SQLite's own refusal of a statement means to the caller: a value a
 * UNIQUE constraint already holds is a CONFLICT naming its columns (as a
 * collection's unique fields are), a statement the runtime stopped at its
 * step budget (`budgetMs`) ran too long, anything else is the statement's
 * mistake.
 */
export function sqlFailure(error: unknown, budgetMs?: number) {
  if (error instanceof DataError) return error;
  if (interrupted(error)) return tooLong(budgetMs);
  const message = String((error as Error)?.message ?? error).replace(
    // The runtime's code, as ": SQLITE_CONSTRAINT (extended: ...)".
    /:\s*SQLITE_[A-Z_]+(\s*\(extended: [A-Z_]+\))?$/,
    "",
  );
  const unique = /UNIQUE constraint failed: (.+)$/.exec(message);
  if (unique) {
    const columns = unique[1]
      .split(",")
      .map((column) => column.trim().split(".").at(-1)!)
      .join(", ");
    return new DataError(
      409,
      `A row already holds that value (${columns}).`,
      "CONFLICT",
      { unique: columns },
    );
  }
  return new DataError(400, `SQL failed: ${message}`, "INVALID_REQUEST");
}
