/**
 * What Naru hands a site's own code (SDK 1.1.0): site functions in
 * `_naru/functions/` and collection rules in `_naru/rules/`, run on Naru.
 * For type checking only; nothing here exists at run time.
 *
 * ```ts
 * import type { Ctx, Readable } from "./functions.d.ts";
 * export async function buy(ctx: Ctx, { item }: { item: string }) { ... }
 * export const readable: Readable = async (ctx, { operation, id }) => true;
 * ```
 *
 * Written by hand beside the generated naru.d.ts, whose `Json`, `Filter`,
 * `Predicate` and `Sort` these repeat so this file stands on its own.
 * @packageDocumentation
 */

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

/** A document's data: its shape is the collection's. */
export type Data = { [key: string]: Json };

/** A stored document, as `ctx.get`, `ctx.add`, `ctx.set` and `ctx.list` give it. */
export interface NaruDocument<T = Data> {
  id: string;
  data: T;
  /** An opaque concurrency token, for a write's `condition`. */
  revision: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The member who created it through the SDK, or null: functions (and the
   * owner and visitors) write documents with no author, whoever called.
   * Functions and rules see every author, whatever a rule's `present` hides.
   */
  createdBy: string | null;
}

/**
 * One page of a list. There are no numbered pages: the next starts at
 * `nextCursor` (null after the last), so page 3 means following cursors from
 * the first page, or keeping the cursors already seen.
 */
export interface Page<T = Data> {
  documents: NaruDocument<T>[];
  nextCursor: string | null;
}

/**
 * Top-level fields, all of which must match: a value, or a range. At most
 * five conditions, and 2 KiB as JSON (it travels in a page's URL).
 */
export type Filter = {
  [field: string]:
    | string
    | number
    | boolean
    | null
    | {
        gt?: string | number;
        gte?: string | number;
        lt?: string | number;
        lte?: string | number;
      };
};

/**
 * A top-level data field by name, or document metadata. `createdAt` and
 * `updatedAt` compare as UTC times written as documents show them, such as
 * `"2026-10-16T09:00:00.000Z"`.
 */
export type Field =
  string | { metadata: "id" | "createdBy" | "createdAt" | "updatedAt" };

/**
 * A condition on documents: a list's `where`, and what a rule's `readable`
 * returns. Values match only their own JSON type; a missing field matches no
 * comparison but `ne`. At most 100 nodes, ten levels deep, and 4 KiB as JSON
 * (it travels in a page's URL).
 */
export type Predicate =
  | boolean
  | { all: readonly Predicate[] }
  | { any: readonly Predicate[] }
  | { eq: readonly [Field, string | number | boolean | null] }
  | { ne: readonly [Field, string | number | boolean | null] }
  | { gt: readonly [Field, string | number] }
  | { gte: readonly [Field, string | number] }
  | { lt: readonly [Field, string | number] }
  | { lte: readonly [Field, string | number] }
  /** Equal to any of 1–100 values. */
  | { in: readonly [Field, readonly (string | number | boolean | null)[]] }
  /** An array data field holding the value. */
  | { has: readonly [string, string | number | boolean | null] }
  /** A string data field with this text in it, 1–100 characters; A–Z in either case. */
  | { contains: readonly [string, string] };

type SortKey = string | { metadata: "id" | "createdAt" | "updatedAt" };
/** One or two keys; the document ID breaks ties. */
export type Sort =
  | readonly [readonly [SortKey, "asc" | "desc"]]
  | readonly [
      readonly [SortKey, "asc" | "desc"],
      readonly [SortKey, "asc" | "desc"],
    ];

export interface ListOptions {
  filter?: Filter;
  where?: Predicate;
  sort?: Sort;
  /** 1–100; 50 when left out. */
  size?: number;
  /** The previous page's `nextCursor`. */
  after?: string | null;
}

/** Write only at this revision, or only if the document does not exist yet. */
export type WriteCondition = { revision: string } | { absent: true };

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
 * What a rule may use of `ctx`: who is asking, and reads. A rule cannot
 * write or send messages.
 */
export interface ReadCtx {
  /** The signed-in member, or null for the owner and visitors. */
  readonly member: { readonly id: string } | null;
  /** The site's owner called (`admin.call`). Rules never run for the owner. */
  readonly owner: boolean;
  /** No one is signed in: a visitor's call, or a visitor's read in a rule. */
  readonly visitor: boolean;
  /** The call's time in milliseconds, fixed for the whole call. */
  readonly now: number;
  /**
   * Refuses the request: the call's writes roll back, and the page's
   * `error.message` is `message` (1–1000 characters) as written, so write it
   * for visitors. `details`, at most 4 KiB of JSON, arrives as
   * `error.details`.
   */
  fail(code: ErrorCode, message: string, details?: Json): never;
  /** A document, or null when there is none. */
  get<T = Data>(
    collection: string,
    id: string,
  ): Promise<NaruDocument<T> | null>;
  /** Up to 100 documents in the order asked, null where missing; one operation. */
  getMany<T = Data>(
    collection: string,
    ids: readonly string[],
  ): Promise<(NaruDocument<T> | null)[]>;
  list<T = Data>(collection: string, options?: ListOptions): Promise<Page<T>>;
  /** How many documents match, or the whole collection. */
  count(
    collection: string,
    options?: { filter?: Filter; where?: Predicate },
  ): Promise<number>;
}

/**
 * A site function's `ctx`: the owner's access to every collection, in one
 * transaction that a throw, a limit or `fail` rolls back whole. Every
 * database method's promise must be used (awaited, returned or chained), or
 * the call fails.
 *
 * A call may make 100 database operations, writes among them (a `getMany`
 * of 100 IDs is one), 3 secret checks, 50 live messages of 4 KiB each and
 * 1,000 URL parses, run for tens of milliseconds in 32 MiB, and return at
 * most 64 KiB of JSON. A member makes 30 calls a minute (120 of read-only
 * exports); a visitor, 20 (60) per address.
 */
export interface Ctx extends ReadCtx {
  /**
   * Adds a document under a new ID. `secret`, 1–256 characters, is a
   * guest's password: Naru keeps only its hash, beside the document, for
   * `secretMatches`.
   */
  add<T = Data>(
    collection: string,
    data: T,
    options?: { secret?: string },
  ): Promise<NaruDocument<T>>;
  /**
   * Creates or replaces the whole document. A `condition` that no longer
   * holds fails the call with `CONFLICT`. Without `secret` a document keeps
   * the one it has.
   */
  set<T = Data>(
    collection: string,
    id: string,
    data: T,
    options?: { condition?: WriteCondition; secret?: string },
  ): Promise<NaruDocument<T>>;
  /** Deletes a document; a missing one is already gone, unless a condition says otherwise. */
  delete(
    collection: string,
    id: string,
    options?: { condition?: { revision: string } },
  ): Promise<null>;
  /**
   * Whether `secret` is the document's (`add`'s or `set`'s `secret`). False
   * when it has none. A document accepts ten wrong secrets an hour; after
   * that every check of it fails with `RATE_LIMITED`.
   */
  secretMatches(
    collection: string,
    id: string,
    secret: string,
  ): Promise<boolean>;
  /**
   * One statement of SQL against the site's own tables, which its
   * `_naru/migrations/*.sql` create. As a tag, ``ctx.sql`... ${value}` ``
   * binds every interpolated value as a parameter; given text and values,
   * it runs a query builder's compiled statement. SELECT, INSERT, UPDATE and
   * DELETE run; a read-only export only reads. Naru's own tables, pragmas,
   * triggers, transactions and recursion are refused, and so is a statement
   * whose plan would read a whole table once for every row of another: join
   * on an indexed column. It returns at most 1,000 rows and 1 MiB (no BLOB
   * values yet) and counts as one database operation.
   */
  sql<Row = Record<string, SqlValue>>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): Promise<SqlResult<Row>>;
  sql<Row = Record<string, SqlValue>>(
    text: string,
    values?: SqlValue[],
  ): Promise<SqlResult<Row>>;
  /** Sends `data` to a member's live connections once the call commits. */
  notify(member: string, data?: Json): void;
  /** Sends `data` to every live listener of `topic` once the call commits. */
  broadcast(topic: string, data?: Json): void;
}

/** A value site SQL binds or returns (a boolean binds as 1 or 0). */
export type SqlValue = string | number | boolean | null;
/** What `ctx.sql` answers: the statement's rows, and how many it changed. */
export interface SqlResult<Row> {
  rows: Row[];
  changes: number;
}

/** A site function: `export async function name(ctx, args)`. */
export type SiteFunction<Args = Json, Result = Json> = (
  ctx: Ctx,
  args: Args,
) => Result | Promise<Result>;

/**
 * What `readable` is asked. `filter` is the caller's (`{}` when none) and
 * `where` their own predicate, or null.
 */
export type ReadableArgs = {
  collection: string;
  filter: Filter;
  where: Predicate | null;
} & (
  | { operation: "get"; id: string; ids?: undefined }
  /** A batch read (`getMany`): the IDs asked for, without repeats. */
  | { operation: "getMany"; id: null; ids: string[] }
  | { operation: "list"; id: null; ids?: undefined }
);

/**
 * `export function readable(ctx, args)`: which documents a member or a
 * visitor may read, as a condition SQL applies before paging and counting.
 * `true` is all, `false` none (an empty list, or `NOT_FOUND`). It is asked
 * again on every page; cursors bind only to the caller's own query.
 */
export type Readable = (
  ctx: ReadCtx,
  args: ReadableArgs,
) => Predicate | Promise<Predicate>;

/** The document a write would leave: its data and author, with the rest of `before`. */
export type Proposed<T = Data> = Pick<
  NaruDocument<T>,
  "id" | "data" | "createdBy"
> &
  Partial<NaruDocument<T>>;

/** What `canWrite` is asked; `before` is read from storage. */
export type CanWriteArgs<T = Data> = { collection: string } & (
  | { operation: "create"; before: null; after: Proposed<T> }
  | { operation: "update"; before: NaruDocument<T>; after: Proposed<T> }
  | { operation: "delete"; before: NaruDocument<T>; after: null }
);

/**
 * `export function canWrite(ctx, args)`: a member's or visitor's write is
 * allowed only when it returns exactly `true`. Functions and the owner skip
 * it.
 */
export type CanWrite<T = Data> = (
  ctx: ReadCtx,
  args: CanWriteArgs<T>,
) => boolean | Promise<boolean>;

/**
 * `export function present(ctx, { collection, document })`: the data a
 * member or visitor reads of `document`, such as without its private
 * fields. A module that exports it also exports `queryable`, and readers
 * see `createdBy` only where it is their own.
 */
export type Present<T = Data> = (
  ctx: ReadCtx,
  args: { collection: string; document: NaruDocument<T> },
) => Data | Promise<Data>;

/**
 * `export const queryable = ["board", "tags"]`: with `present`, the fields
 * readers may filter, `where` and sort on. `createdBy` may be asked only as
 * `{ eq: [{ metadata: "createdBy" }, <their own member ID>] }`.
 */
export type Queryable = readonly string[];
