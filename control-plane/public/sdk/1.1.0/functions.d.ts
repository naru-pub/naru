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
  /** The site's owner's Naru login, whoever calls: the site's own name. */
  readonly ownerName: string;
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
   * transactions and recursion are refused. A statement is stopped once
   * SQLite works on one step of it for 3 seconds; one stopped 3 times within
   * a minute is paused for 5 minutes. It binds at most 100 values, returns at most 1,000 rows and 1 MiB, BLOB columns as
   * Uint8Arrays, and counts as one database operation; a call's statements
   * read at most 500,000 rows. A value a UNIQUE column already holds fails
   * the call with CONFLICT, `details.unique` naming the column; any other
   * mistake SQLite refuses, with its message.
   *
   * To stay fast, read a table whole at most once and reach every other
   * table by key (join on an indexed column):
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
   * The members holding `role`, by member ID: up to `limit` (at most 100)
   * after `after`, and `next` to go on from (null at the end).
   */
  membersWithRole(
    role: string,
    options?: { after?: string; limit?: number },
  ): Promise<{ members: string[]; next: string | null }>;
  /**
   * Counts Naru keeps beside the site's tables, by name (1–64 of letters,
   * digits, `_ . : -`) and key (a string or number): view counts and the like.
   * A query may count, so a page reading a post can count its view in the
   * same call; no count re-runs a live query, and a live query's re-run counts
   * nothing. Counts are kept in restore points with the site's tables.
   */
  counters: {
    /** Each key's count (0 if never counted): at most 100 keys. */
    get(
      name: string,
      keys: (string | number)[],
    ): Promise<Record<string, number>>;
    /** Adds `by` (1 unless given, a whole number) and answers the count. */
    increment(name: string, key: string | number, by?: number): Promise<number>;
  };
  /**
   * The site's uploads, as Naru Media recorded them when each was finished:
   * `get` takes an upload's address or ID and answers who uploaded it
   * (`member`, null for the owner), its name, type and size in bytes, or null
   * for anything else. `types` is what Naru Media stores.
   */
  media: {
    get(urlOrId: string): Promise<{
      id: string;
      url: string;
      member: string | null;
      name: string;
      type: string;
      size: number;
      createdAt: number;
    } | null>;
    readonly types: readonly string[];
  };
  /**
   * What one browser's calls share, for a while: the browser SDK sends a
   * random ID of its own with each query and mutation, so this is null for
   * calls without one (live queries, older SDKs). Values are at most 4 KiB of
   * JSON, 100 a browser, each kept `ttl` seconds (a day unless given, 30 days
   * at most). The browser chooses its ID: use a session for things such as
   * counting a view once, never to decide who may do what.
   */
  readonly session: {
    get(key: string): Promise<Json | null>;
    set(key: string, value: Json, options?: { ttl?: number }): Promise<null>;
    delete(key: string): Promise<null>;
  } | null;
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
  counters: QueryCtx["counters"] & {
    /** Forgets a key's count, or with no key every count of `name`. */
    delete(name: string, key?: string | number): Promise<null>;
  };
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
