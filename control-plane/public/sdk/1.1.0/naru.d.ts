/**
 * Naru Data SDK 1.1.0: browser SDK for data owned by one Naru site, its
 * owner and its members. This release is still under active development.
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
  /**
   * The member who created the document, by their member ID, which a
   * replacement keeps. Null for one the site's owner, a visitor or a site
   * function created. Where the collection's rule exports `present` (1.1.0),
   * a member sees only their own: anyone else's reads as null, and `where`
   * may ask about it only as `{ eq: [{ metadata: "createdBy" }, member.id] }`.
   */
  createdBy: string | null;
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
 * it as is (`status.textContent = error.message`): a site function's own
 * `ctx.fail` message, or Naru's wording for `code`. Naru's English account of
 * what went wrong, for developers, is `error.cause.message`.
 */
export declare class NaruError extends Error {
  private constructor();
  readonly code: NaruErrorCode;
  /**
   * The JSON a site function passed as `ctx.fail(code, message, details)`,
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

/**
 * A top-level user field by name, or document metadata. `createdAt` and
 * `updatedAt` (1.1.0) compare as UTC times written as documents show them,
 * such as `"2026-10-16T09:00:00.000Z"`.
 */
export type PredicateField =
  string | { metadata: "id" | "createdBy" | "createdAt" | "updatedAt" };

/**
 * A condition on documents, as a collection rule's `readable` returns: `true`,
 * `false`, `all` or `any` of conditions, or one comparison. Values match only
 * their own JSON type; a missing field matches no comparison except `ne`.
 * At most 100 nodes, ten levels deep.
 */
export type Predicate =
  | boolean
  | { all: readonly Predicate[] }
  | { any: readonly Predicate[] }
  | { eq: readonly [PredicateField, string | number | boolean | null] }
  | { ne: readonly [PredicateField, string | number | boolean | null] }
  | { gt: readonly [PredicateField, string | number] }
  | { gte: readonly [PredicateField, string | number] }
  | { lt: readonly [PredicateField, string | number] }
  | { lte: readonly [PredicateField, string | number] }
  | {
      /** Equal to any of 1–100 values. */
      in: readonly [
        PredicateField,
        readonly (string | number | boolean | null)[],
      ];
    }
  | {
      /** An array field holding the value (1.1.0). */
      has: readonly [string, string | number | boolean | null];
    }
  | {
      /**
       * A string field with this text in it, 1–100 characters; A–Z match
       * in either case (1.1.0).
       */
      contains: readonly [string, string];
    };

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
  /** Combined with `filter`: documents must match both. */
  where?: Predicate;
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

/**
 * A handle on one collection, the same for a visitor, a member and the owner:
 * what each may do, the collection's permissions and rules decide on Naru.
 */
export interface Collection<T = Json> {
  get(id: string, options?: { signal?: AbortSignal }): Promise<Document<T>>;
  /** One bounded read, in input order; missing or unreadable rows are null. */
  getMany(
    ids: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<(Document<T> | null)[]>;
  list(options?: ListOptions): Promise<Page<T>>;
  /** How many documents match `filter` and `where`, or the whole collection. */
  count(options?: {
    filter?: Filter;
    where?: Predicate;
    signal?: AbortSignal;
  }): Promise<number>;
  /**
   * Every page of a query in turn, following `nextCursor` from `after` (or
   * the start). Not a snapshot: writes in between can shift later pages.
   */
  pages(options?: ListOptions): AsyncIterable<Page<T>>;
  /**
   * Adds a document under a new ID. A guest's post that its writer may edit
   * later with a password is a site function's: `ctx.add(collection, data,
   * { secret })` keeps the password's hash, `ctx.secretMatches` checks it.
   */
  add(data: T, options?: { signal?: AbortSignal }): Promise<Document<T>>;
  /**
   * Replaces the whole document, or creates it, when the collection or its
   * rule allows: the owner always; a member, a document they created or the
   * one named by their own `member.id`.
   */
  set(
    id: string,
    data: T,
    options?: { condition?: WriteCondition; signal?: AbortSignal },
  ): Promise<Document<T>>;
  /**
   * Deletes a document, as `set` may replace it. Deleting a missing document
   * succeeds unless a condition was supplied.
   */
  delete(
    id: string,
    options?: { condition?: { revision: Revision }; signal?: AbortSignal },
  ): Promise<void>;
}

/** @deprecated 1.0.0's name for a visitor's handle, kept so 1.0.0 code compiles: use `Collection`. */
export type PublicCollection<T = Json> = Collection<T>;
/** @deprecated 1.0.0's name for the owner's handle, kept so 1.0.0 code compiles: use `Collection`. */
export type AdminCollection<T = Json> = Collection<T>;

/** A visitor signed in to this site with their Naru account. */
export interface Member {
  /**
   * This member's ID on this site, the same on every visit. Documents they
   * create carry it as `createdBy`. It is not their Naru account name.
   */
  readonly id: string;
  collection<T = Json>(name: string): Collection<T>;
  /**
   * Calls one of the site's functions, `"<module/path>:<function>"`: an export of
   * the site's `_naru/functions/<module/path>.js`. It runs on Naru, in one
   * transaction, with the site owner's access to its collections, and
   * resolves with what it returned. A function that throws, or exceeds its
   * limits, changes nothing. Exports the module lists in
   * `export const readOnly = [...]` cannot write, and count against the
   * member's read budget instead of their calls. Static relative JavaScript
   * imports and re-exports may share code in `_naru/modules/`; imports stay
   * within `_naru/functions/` and `_naru/modules/`. Include `.js`; dynamic
   * imports and top-level await are unsupported. File updates activate an
   * immutable source revision.
   */
  call<R = Json>(
    name: string,
    args?: Json,
    options?: { signal?: AbortSignal },
  ): Promise<R>;
  /**
   * Hears what the site's functions send this member (`ctx.notify`), and
   * broadcasts to `topics`, until closed or until their access ends.
   */
  live(options: LiveOptions): Live;
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

export interface Admin {
  collection<T = Json>(name: string): Collection<T>;
  /**
   * Calls one of the site's functions as the owner, as `Member.call` does
   * for a member: the function sees `ctx.member` null and `ctx.owner` true,
   * whatever collections this sign-in approved. Owner calls are not counted
   * against the site's budget.
   */
  call<R = Json>(
    name: string,
    args?: Json,
    options?: { signal?: AbortSignal },
  ): Promise<R>;
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

/** What a live connection hears from the site's functions. */
export type LiveMessage =
  /** `ctx.notify(memberId, data)` to the member this connection signed in as. */
  | { type: "notice"; data: Json }
  /** `ctx.broadcast(topic, data)` to every listener of the topic. */
  | { type: "topic"; topic: string; data: Json };

export interface LiveOptions {
  /** Up to eight topic names whose broadcasts to hear. */
  topics?: readonly string[];
  onMessage(message: LiveMessage): void;
  /**
   * Called as the connection opens, drops and reconnects, and once it is
   * closed for good: by `close()`, or because the member's access ended.
   * Messages sent while it was down are not delivered later, so read again
   * on `open` if they matter.
   */
  onStatus?(status: "connecting" | "open" | "reconnecting" | "closed"): void;
}

/** A live connection, reconnecting by itself until closed. */
export interface Live {
  close(): void;
}

export interface NaruClient {
  /** Visitor access, even when signed in. */
  collection<T = Json>(name: string): Collection<T>;
  /**
   * Hears what the site's functions broadcast to `topics`, as anyone may:
   * broadcasts are public. Connecting counts against the site's budget.
   */
  live(options: LiveOptions): Live;
  /**
   * Calls a site function as a visitor, signed in to nothing: only exports
   * the module lists in `export const visitors = [...]`; others fail with
   * `AUTH_REQUIRED`. The function sees `ctx.visitor` true and `ctx.member`
   * null. Calls are limited per visitor address and count against the
   * site's budget.
   */
  call<R = Json>(
    name: string,
    args?: Json,
    options?: { signal?: AbortSignal },
  ): Promise<R>;
  auth: {
    /**
     * The admin client for this page, or null. A sign-in that was denied,
     * went stale or could not be exchanged also resolves null.
     */
    session(): Promise<Admin | null>;
    /** Redirects to Naru for approval. */
    signIn(options: {
      collections: readonly string[];
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

/** Creates a client bound to one site. */
export declare function createNaru(options?: { site?: string }): NaruClient;

export {};
