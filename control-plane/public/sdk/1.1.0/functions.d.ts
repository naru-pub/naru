/**
 * What Naru hands a site's own code (SDK 1.1.0): queries in
 * `_naru/queries/`, mutations in `_naru/mutations/` and routes in
 * `_naru/routes/`, run on Naru over the tables `_naru/migrations/*.sql`
 * create. For type checking only; nothing here exists at run time.
 *
 * ```ts
 * import type { Query, Mutation } from "./functions.d.ts";
 * export const posts: Query<{ board: string }> = async (ctx, { board }) =>
 *   (await ctx.sql`SELECT id, title FROM posts WHERE board = ${board}`).rows;
 * ```
 *
 * The code runs in QuickJS, not a browser or Node. Its globals are the
 * language's own (Object, Array, JSON, Math, Date, RegExp, Map, Set, WeakMap,
 * WeakSet, WeakRef, Promise, Proxy, Reflect, Symbol, BigInt, Iterator,
 * ArrayBuffer, DataView, the typed arrays, the Error types, the URI
 * functions, parseInt and the like) and: URL and URLSearchParams, as
 * browsers have them; structuredClone, for primitives, plain objects and
 * arrays, Date, RegExp, Map, Set, ArrayBuffer and Uint8Array (anything else
 * throws a DataCloneError); Math.random; Date.now, the server's clock (prefer
 * `ctx.now`; local time is the server's, so use UTC methods);
 * performance.now, queueMicrotask and DOMException. There is no Intl
 * (toLocaleString formats as English), TextEncoder, TextDecoder, atob, btoa,
 * crypto, console, fetch, setTimeout or other timers, WebAssembly, require or
 * process, whatever your editor's lib types say.
 *
 * Written by hand beside the generated naru.d.ts, whose `Json` this repeats
 * so this file stands on its own.
 * @packageDocumentation
 */

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

/** The failure codes `ctx.fail` takes, as pages receive them in `error.code`. */
export type ErrorCode =
  | "CONFLICT"
  | "QUOTA_EXCEEDED"
  | "AUTH_REQUIRED"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

/**
 * The member who called, and the roles the site gave them (names such as
 * `staff`, set on the control panel or by `setRoles`).
 */
export interface CallingMember {
  readonly id: string;
  readonly roles: readonly string[];
}

/** A value site SQL binds or returns (a boolean binds as 1 or 0). */
export type SqlValue = string | number | boolean | Uint8Array | null;
/** What `ctx.sql` answers: the statement's rows, and how many it changed. */
export interface SqlResult<Row> {
  rows: Row[];
  changes: number;
}

/**
 * A query's or route's `ctx`: who calls, and the site's own tables through
 * `sql`. Anyone may call one, signed in or not, so its code decides what
 * each caller may see. A query's `sql` only reads. A call runs in one
 * transaction, for tens of milliseconds in 32 MiB, makes at most 100
 * database operations and 1,000 URL parses, reads at most 500,000 rows in
 * all, and returns at most 1 MiB of JSON. Every method's promise must be
 * used (awaited, returned or chained), or the call fails.
 */
export interface QueryCtx {
  /** The signed-in member, or null for the owner and visitors. */
  readonly member: CallingMember | null;
  /** The site's owner called. */
  readonly owner: boolean;
  /** No one is signed in. */
  readonly visitor: boolean;
  /** The call's time in milliseconds, fixed for the whole call. */
  readonly now: number;
  /**
   * Refuses the request: nothing the call wrote is kept, and the page's
   * `error.message` is `message` (1–1000 characters) as written, so write it
   * for visitors. `details`, at most 4 KiB of JSON, arrives as
   * `error.details`.
   */
  fail(code: ErrorCode, message: string, details?: Json): never;
  /**
   * One statement of SQL against the site's own tables, which its
   * `_naru/migrations/*.sql` create. As a tag, ``ctx.sql`... ${value}` ``
   * binds every interpolated value as a parameter; given text and values,
   * it runs a query builder's compiled statement. SELECT, INSERT, UPDATE and
   * DELETE run; a query only reads. Naru's own tables, pragmas, triggers,
   * transactions and recursion are refused. A statement's plan may make one
   * full pass over a table; every other table is reached by key (join on an
   * indexed column), and a correlated subquery may not scan. It binds at
   * most 100 values, returns at most 1,000 rows and 1 MiB, BLOB columns as
   * Uint8Arrays, and counts as one database operation; a call's statements
   * read at most 500,000 rows. A value a UNIQUE column already holds fails
   * the call with CONFLICT, `details.unique` naming the column; any other
   * mistake SQLite refuses, with its message.
   *
   * - A list as one value: `WHERE id IN (SELECT value FROM json_each(?))`,
   *   bound as `JSON.stringify(ids)`.
   * - A row's JSON column: `FROM visits, json_each(visits.hours) j`.
   * - An ordered aggregate per row: `(SELECT json_group_array(title) FROM
   *   (SELECT title FROM titles WHERE ch = c.id ORDER BY ord))`, with an
   *   index on `titles (ch, ord)`.
   * - Past 1,000 rows: `WHERE id > ? ORDER BY id LIMIT 1000`, then again
   *   after the last `id`.
   */
  sql<Row = Record<string, SqlValue>>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): Promise<SqlResult<Row>>;
  sql<Row = Record<string, SqlValue>>(
    text: string,
    values?: SqlValue[],
  ): Promise<SqlResult<Row>>;
  /** Members' roles, by ID: at most 100 IDs a call; a member without any has []. */
  rolesOf(members: string[]): Promise<Record<string, string[]>>;
  /**
   * Guests' passwords, kept by the site as hashes. `verify` allows ten wrong
   * passwords an hour for each `key` (such as "post:42"), whoever tries,
   * then fails with RATE_LIMITED. A call makes at most 3 password checks.
   */
  passwords: {
    verify(password: string, hash: string, key: string): Promise<boolean>;
  };
}

/** A mutation's `ctx`: a query's, writing, and granting roles. */
export interface MutationCtx extends QueryCtx {
  passwords: QueryCtx["passwords"] & {
    /** A hash of `password` (1–256 characters) to keep in a table. */
    hash(password: string): Promise<string>;
  };
  /**
   * Replaces a member's roles with these (at most 16 names); [] clears
   * them. Kept only if the mutation returns.
   */
  setRoles(member: string, roles: string[]): Promise<null>;
}

/** `export async function name(ctx, args)` in `_naru/queries/` or `_naru/mutations/`. */
export type Query<Args = Json, Result = Json> = (
  ctx: QueryCtx,
  args: Args,
) => Result | Promise<Result>;
export type Mutation<Args = Json, Result = Json> = (
  ctx: MutationCtx,
  args: Args,
) => Result | Promise<Result>;
