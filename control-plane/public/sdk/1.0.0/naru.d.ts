/**
 * Naru Data SDK 1.0.0: browser SDK for data owned by one Naru site.
 * @packageDocumentation
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

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

/** A Naru operation that could not be completed. Check it with `instanceof`. */
export declare class NaruError extends Error {
  private constructor();
  readonly code: NaruErrorCode;
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

export interface Admin {
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
     * Stores a file publicly. Large photos may be shrunk first. A HEIC photo
     * this browser cannot convert throws a `TypeError` before anything is sent.
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
      url: string;
      name: string;
      contentType: string;
      size: number;
    }>;
  };
  /** This handle stops working at once, even if the revoke request fails. */
  signOut(): Promise<void>;
}

export interface NaruClient {
  /** Visitor access, even when signed in. */
  collection<T = Json>(name: string): PublicCollection<T>;
  auth: {
    /**
     * The admin client for this page, or null. A sign-in that was denied,
     * went stale or could not be exchanged also resolves null.
     */
    session(): Promise<Admin | null>;
    /** Redirects to Naru for approval. */
    signIn(options: { collections: readonly string[] }): Promise<void>;
  };
}

/** Creates a client bound to one site. */
export declare function createNaru(options?: { site?: string }): NaruClient;

export {};
