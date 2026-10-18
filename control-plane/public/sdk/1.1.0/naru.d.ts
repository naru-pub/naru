/**
 * Naru Data SDK 1.1.0: browser SDK for data owned by one Naru site: 1.0.0's
 * collections, with the site's own tables reached through its queries and
 * mutations, live queries, and its members. This release is still under
 * active development.
 * @packageDocumentation
 */

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

/** @internal */
declare const revisionBrand: unique symbol;
/** An opaque concurrency token. Store and return it unchanged. */
export type Revision = string & { readonly [revisionBrand]: true };

/** A read or successful write: user data stays separate from server metadata. */
export interface Document<T = Json> {
  id: string;
  data: T;
  createdAt: string;
  updatedAt: string;
  revision: Revision;
}

export interface Page<T = Json> {
  documents: Document<T>[];
  nextCursor: string | null;
  totalCount?: number;
}

/**
 * Why an operation failed. The list is closed for v1: a code a later server
 * adds reaches this version as the nearest code here.
 */
export type NaruErrorCode =
  | "CONFLICT"
  | "QUOTA_EXCEEDED"
  | "AUTH_REQUIRED"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "UNAVAILABLE";

/**
 * A Naru operation that could not be completed. Check it with `instanceof`.
 *
 * `message` is a short Korean sentence a visitor can read, so a page may show
 * it as is (`status.textContent = error.message`): a query's or mutation's
 * own `ctx.fail` message, or Naru's wording for `code`. Naru's English account of
 * what went wrong, for developers, is `error.cause.message`.
 */
export declare class NaruError extends Error {
  private constructor();
  readonly code: NaruErrorCode;
  /**
   * The JSON a query or mutation passed as `ctx.fail(code, message, details)`,
   * such as `{ reason: "sold_out" }`; or, when a member's request is refused
   * because the site has not approved them, `{ membership: "pending" }` or
   * `{ membership: "banned" }`; or, for a `CONFLICT` because another
   * document already holds a value of one of the collection's unique
   * fields, `{ unique: "<field>" }`. Undefined for every other failure.
   */
  readonly details?: Json;
}

/** Top-level user fields, combined with AND. */
export type Filter = Record<
  string,
  | string
  | number
  | boolean
  | null
  | {
      gt?: string | number;
      gte?: string | number;
      lt?: string | number;
      lte?: string | number;
    }
>;

/** One or two keys: a user field by name, or document metadata. */
export type Sort =
  | readonly [
      readonly [
        string | { metadata: "id" | "createdAt" | "updatedAt" },
        "asc" | "desc",
      ],
    ]
  | readonly [
      readonly [
        string | { metadata: "id" | "createdAt" | "updatedAt" },
        "asc" | "desc",
      ],
      readonly [
        string | { metadata: "id" | "createdAt" | "updatedAt" },
        "asc" | "desc",
      ],
    ];

export interface ListOptions {
  filter?: Filter;
  sort?: Sort;
  /** Default 50; maximum 100. */
  size?: number;
  /** Opaque cursor returned by the preceding page. */
  after?: string | null;
  includeTotal?: boolean;
  signal?: AbortSignal;
}

/** Write only at this revision, or only if the document does not exist yet. */
export type WriteCondition = { revision: Revision } | { absent: true };

export interface PublicCollection<T = Json> {
  get(id: string, options?: { signal?: AbortSignal }): Promise<Document<T>>;
  list(options?: ListOptions): Promise<Page<T>>;
  /** How many documents match `filter`, or the whole collection. */
  count(options?: { filter?: Filter; signal?: AbortSignal }): Promise<number>;
  /**
   * Every page of a query in turn, following `nextCursor` from `after` (or
   * the start). Not a snapshot: writes in between can shift later pages.
   */
  pages(options?: ListOptions): AsyncIterable<Page<T>>;
  add(data: T, options?: { signal?: AbortSignal }): Promise<Document<T>>;
}

export interface AdminCollection<T = Json> extends PublicCollection<T> {
  /** Replaces the whole document or creates it. */
  set(
    id: string,
    data: T,
    options?: { condition?: WriteCondition; signal?: AbortSignal },
  ): Promise<Document<T>>;
  /** Deleting a missing document succeeds unless a condition was supplied. */
  delete(
    id: string,
    options?: { condition?: { revision: Revision }; signal?: AbortSignal },
  ): Promise<void>;
}

/** A visitor signed in to this site with their Naru account. */
export interface Member extends SiteCode, LiveQueries {
  /**
   * This member's ID on this site, the same on every visit: `ctx.member.id`
   * in the site's queries and mutations. It is not their Naru account name.
   */
  readonly id: string;
  media: {
    /** Deletes one of this member's own uploads by ID. */
    delete(id: string, options?: { signal?: AbortSignal }): Promise<void>;
    /**
     * Stores a file publicly, in the site's media. Large photos may be shrunk
     * first. A HEIC photo this browser cannot convert throws a `TypeError`
     * before anything is sent.
     */
    upload(
      file: File | Blob,
      options?: {
        signal?: AbortSignal;
        /** As for an owner's upload. */
        onProgress?: (
          progress:
            | { phase: "preparing" }
            | { phase: "uploading"; loaded: number; total: number }
            | { phase: "finishing" },
        ) => void;
      },
    ): Promise<{
      id: string;
      url: string;
      name: string;
      contentType: string;
      size: number;
    }>;
  };
  /**
   * Signs out on every page of this site. This handle stops working at once,
   * even if the revoke request fails.
   */
  signOut(): Promise<void>;
}

/**
 * The site's queries and mutations: its own code over its own tables, which its `_naru/migrations/` create. Anyone may call them,
 * signed in or not; the code decides what each caller may see and do from
 * `ctx.member`, `ctx.owner` and `ctx.visitor`.
 */
export interface SiteCode {
  /**
   * Runs `"<module/path>:<name>"`, an export of the site's
   * `_naru/queries/<module/path>.js`, and resolves with what it returned. A
   * query only reads (`ctx.sql`), so it counts against the caller's read
   * budget.
   */
  query<R = Json>(
    name: string,
    args?: Json,
    options?: { signal?: AbortSignal },
  ): Promise<R>;
  /**
   * Runs an export of `_naru/mutations/<module/path>.js` in one transaction:
   * what it wrote is kept only if it returns, and a throw, `ctx.fail` or a
   * limit changes nothing.
   */
  mutate<R = Json>(
    name: string,
    args?: Json,
    options?: { signal?: AbortSignal },
  ): Promise<R>;
}

/**
 * The owner signed in on this page. Its queries and mutations see
 * `ctx.member` null and `ctx.owner` true, whatever collections this sign-in
 * approved, and are not counted against the site's budget.
 */
export interface Admin extends SiteCode, LiveQueries {
  collection<T = Json>(name: string): AdminCollection<T>;
  /**
   * Commits every write or none. Conditions guard individual documents. Does
   * not retry. Resolves, in the order written, with what each `set` stored and
   * `null` for each `delete`.
   */
  batch(
    writes: readonly (
      | {
          collection: string;
          set: { id: string; data: unknown; condition?: WriteCondition };
        }
      | {
          collection: string;
          delete: { id: string; condition?: { revision: Revision } };
        }
    )[],
    options?: { signal?: AbortSignal },
  ): Promise<
    ({
      id: string;
      revision: Revision;
      createdAt: string;
      updatedAt: string;
    } | null)[]
  >;
  media: {
    /**
     * Deletes any of the site's uploads by ID. Needs a sign-in that asked for
     * it: `auth.signIn({ collections, mediaDelete: true })`.
     */
    delete(id: string, options?: { signal?: AbortSignal }): Promise<void>;
    /**
     * Stores a file publicly. Large photos may be shrunk first. A HEIC photo
     * this browser cannot convert throws a `TypeError` before anything is sent.
     * Like every upload, it stays until deleted, since media may be linked
     * from anywhere; Naru notes which of the site's documents name its URL
     * (in any field, HTML included), and the media library marks it when
     * none does.
     */
    upload(
      file: File | Blob,
      options?: {
        signal?: AbortSignal;
        /**
         * Called as the upload moves along: `preparing` while a photo is
         * shrunk and the upload authorized, `uploading` with the bytes sent
         * so far of the `total` actually sent (after shrinking), then
         * `finishing` while storage confirms and Naru records the file.
         * `loaded` can reach `total` before storage has answered.
         */
        onProgress?: (
          progress:
            | { phase: "preparing" }
            | { phase: "uploading"; loaded: number; total: number }
            | { phase: "finishing" },
        ) => void;
      },
    ): Promise<{
      id: string;
      url: string;
      name: string;
      contentType: string;
      size: number;
    }>;
  };
  /** This handle stops working at once, even if the revoke request fails. */
  signOut(): Promise<void>;
}

/** A live query, kept current until closed. */
export interface Live {
  close(): void;
}

/** Live queries: a query's answer, kept current. */
export interface LiveQueries {
  /**
   * Runs `"<module/path>:<query>"` from the site's `_naru/queries/` as
   * `query()` does, calls `onResult` with its answer, and again whenever a
   * write changes a table it read and the answer with it, until closed.
   * After the connection drops it is asked again, so the latest answer
   * arrives once it is back. A failure, now or later, goes to `onError`.
   * A connection holds at most 20. `args` left `undefined` is `null`, as
   * `query()`'s are.
   */
  subscribe<R = Json>(
    name: string,
    args: Json | undefined,
    onResult: (result: R) => void,
    options?: { onError?(error: NaruError): void },
  ): Live;
}

/**
 * A page's client. Its queries and mutations run as a visitor, signed in to
 * nothing: they see `ctx.visitor` true and `ctx.member` null, are limited per
 * visitor address, and count against the site's budget.
 */
export interface NaruClient extends SiteCode, LiveQueries {
  /** Visitor access, even when signed in. */
  collection<T = Json>(name: string): PublicCollection<T>;
  auth: {
    /**
     * The admin client for this page, or null. A sign-in that was denied,
     * went stale or could not be exchanged also resolves null.
     */
    session(): Promise<Admin | null>;
    /** Redirects to Naru for approval. */
    signIn(options?: {
      /**
       * The collections this page manages directly. None, for a page that
       * manages the site through its queries and mutations as the owner.
       */
      collections?: readonly string[];
      /** Request explicit permission to delete all of this site's media. */
      mediaDelete?: boolean;
    }): Promise<void>;
  };
  members: {
    /**
     * The member signed in to this site, or null. A sign-in stays on every
     * page and tab of the site until it ends. Finishes a sign-in when Naru has
     * just redirected back; one that was denied or could not be exchanged
     * resolves null.
     */
    session(): Promise<Member | null>;
    /**
     * Redirects to Naru, where the visitor signs in with a Naru account (or
     * makes one), and back to this page.
     */
    signIn(): Promise<void>;
  };
}

/**
 * The types Naru Media stores (the server refuses others), for a page that
 * checks a file before uploading it. Site code reads them as ctx.media.types.
 */
export declare const MEDIA_TYPES: readonly string[];

/** Creates a client bound to one site. */
export declare function createNaru(options?: { site?: string }): NaruClient;

export {};
