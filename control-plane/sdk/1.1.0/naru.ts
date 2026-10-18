/**
 * Naru Data SDK 1.1.0: browser SDK for data owned by one Naru site: 1.0.0's
 * collections, with the site's own tables reached through its queries and
 * mutations, live queries, and its members. This release is still under
 * active development.
 * @packageDocumentation
 */

// This file is the SDK. `pnpm sdk:build` emits public/sdk/1.1.0/naru.js and
// naru.d.ts from it, and those emitted files are what is committed, served and
// tested; `pnpm build` refuses to proceed while they are stale. Only the names
// an application writes itself, including in helpers that pass options along,
// are exported: every exported name is one v1 can never rename. The rest are
// spelled out where they are used.

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
export class NaruError extends Error {
  private constructor(message: string, code: NaruErrorCode, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NaruError";
    this.code = code;
  }
  declare readonly code: NaruErrorCode;
  /**
   * The JSON a query or mutation passed as `ctx.fail(code, message, details)`,
   * such as `{ reason: "sold_out" }`; or, when a member's request is refused
   * because the site has not approved them, `{ membership: "pending" }` or
   * `{ membership: "banned" }`; or, for a `CONFLICT` because another
   * document already holds a value of one of the collection's unique
   * fields, `{ unique: "<field>" }`. Undefined for every other failure.
   */
  declare readonly details?: Json;
}

// The constructor is private to applications, and TypeScript keeps it to the
// class body. This module is where errors are made, so it names the runtime
// constructor as a type and reaches it through that. The cast emits nothing,
// and goes through `unknown` because whether a private constructor compares
// to a public one depends on which ambient declarations are loaded.
type Fail = new (
  message: string,
  code: NaruErrorCode,
  cause?: unknown,
) => NaruError;

/** How a page's visitors read each failure. */
const WORDS: Record<NaruErrorCode, string> = {
  CONFLICT: "다른 곳에서 먼저 바뀌었습니다. 새로고침한 뒤 다시 해 주세요.",
  QUOTA_EXCEEDED: "사이트의 사용 한도에 도달했습니다.",
  AUTH_REQUIRED: "로그인이 필요합니다. 다시 로그인해 주세요.",
  ACCESS_DENIED: "권한이 없습니다.",
  NOT_FOUND: "찾는 자료가 없습니다.",
  RATE_LIMITED: "요청이 너무 많습니다. 잠시 뒤에 다시 해 주세요.",
  INVALID_REQUEST: "요청을 처리할 수 없습니다.",
  UNAVAILABLE: "나루에 연결하지 못했습니다. 잠시 뒤에 다시 해 주세요.",
};

/**
 * A NaruError worded for visitors (`words`, or the code's), keeping Naru's
 * English `account` of it, and what caused that, as the cause.
 */
function naruError(
  code: NaruErrorCode,
  account: string,
  { words, cause }: { words?: string; cause?: unknown } = {},
) {
  return new (NaruError as unknown as Fail)(
    words ?? WORDS[code],
    code,
    new Error(account, cause === undefined ? undefined : { cause }),
  );
}

/** The NaruError for what the server answered: `error` with its HTTP `status`. */
function failure(
  status: number,
  error:
    | { code?: string; message?: unknown; details?: Json; site?: boolean }
    | undefined,
) {
  const code = errorCode(status, error?.code);
  const account =
    typeof error?.message === "string"
      ? error.message
      : `Database request failed (HTTP ${status}).`;
  // Site code's ctx.fail message is already written for visitors. A
  // value a unique field already holds is no concurrent change, as other
  // conflicts are: it is worded on its own.
  const unique = (error?.details as { unique?: unknown } | undefined)?.unique;
  const failed = naruError(code, account, {
    words:
      error?.site === true
        ? account
        : code === "CONFLICT" && typeof unique === "string"
          ? `이미 쓰이고 있는 값입니다(${unique}). 다른 값으로 해 주세요.`
          : undefined,
  });
  // What site code passed to ctx.fail, for the page to branch on.
  if (error?.details !== undefined)
    Object.defineProperty(failed, "details", {
      value: error.details,
      enumerable: true,
    });
  return failed;
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
          // Any value, as one collection's own type would be: a batch spans
          // collections, and is checked for JSON when it is called.
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

/* ----------------------------------------------------------- the wire ---- */

// What one request needs beyond its URL. `touches` names the collection paths
// a write lands in, so later reads of them skip caches.
interface Transport {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
  touches: readonly string[];
  renew?: (expiresAt: number) => void;
  /** Sends this browser's session ID (ctx.session): queries and mutations. */
  session?: boolean;
}
type Send = <Result>(
  url: string,
  init: Omit<Transport, "token" | "renew">,
) => Promise<Result>;

// The server's answers, in the shapes v1 fixes. Only the fields read here are
// named; the server may add more.
type Written = Pick<Document, "id" | "revision" | "createdAt" | "updatedAt">;
interface Authorization {
  id: string;
  uploadUrl: string;
  headers: Record<string, string>;
}
interface Stored {
  file: {
    id: string;
    url: string;
    name: string;
    contentType: string;
    size: number;
  };
}
interface Token {
  accessToken: string;
  expiresIn?: number;
  expiresAt: number;
  /** A member token's member. */
  memberId?: string;
}
interface Context {
  site: string;
  origin: string;
  root: string;
}
// A pending or finished sign-in, as this tab's storage holds it.
interface Pending {
  verifier: string;
  state: string;
  startedAt: number;
  /** The page's whole address, query included, to return to. */
  address?: string;
}
interface Session {
  accessToken: string;
  expiresAt: number;
  memberId?: string;
}
// Everything a batch write may carry; which of `set` and `delete` is present
// is checked when the batch is called, so one shape serves both.
interface BatchWrite {
  collection: string;
  set?: { id: string; data: unknown; condition?: WriteCondition };
  delete?: { id: string; condition?: { revision: Revision } };
}
// A Blob has no name, and a File's may be empty.
type Source = Blob & { name?: string };

// The server names the code. Only the codes this version knows are passed on,
// so a code added later reads as the nearest one this version has.
const CODES = new Set<string>([
  "CONFLICT",
  "QUOTA_EXCEEDED",
  "AUTH_REQUIRED",
  "ACCESS_DENIED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "UNAVAILABLE",
]);
const errorCode = (status: number, code: unknown): NaruErrorCode => {
  if (CODES.has(code as string)) return code as NaruErrorCode;
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "ACCESS_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UNAVAILABLE";
  return "INVALID_REQUEST";
};
const CONTROL_PLANE = "https://naru.pub";
// The data API, served from Seoul (sdk.naru.pub); sign-in stays on naru.pub.
const DATA_API = "https://sdk.naru.pub";
const SITE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
// Where requests go: the data API at sdk.naru.pub, sign-in at naru.pub. A
// page on alice.naru.pub belongs to the site alice, so only custom domains and
// local development say which site.
function target({ site }: { site?: string } = {}): Context {
  site ||= /^([a-z0-9-]+)\.naru\.pub$/.exec(
    globalThis.location?.hostname ?? "",
  )?.[1];
  if (typeof site !== "string" || !SITE.test(site))
    throw new TypeError(
      "Pass { site: <Naru login name> } when the page is not on <site>.naru.pub.",
    );
  return {
    site,
    origin: CONTROL_PLANE,
    root: `${DATA_API}/api/data/v1/${site}`,
  };
}

// A document ID becomes a path segment. Checking it here keeps "..", which a
// URL would resolve away, from ever addressing something else.
function segment(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value))
    throw new TypeError(
      "Names and IDs are 1-64 ASCII letters, digits, underscores or hyphens.",
    );
  return value;
}

// Once this module writes a collection, its subsequent reads bypass caches.
// No cache lifetime is baked into deployed SDKs; the server may change it.
const written = new Set<string>();

// Accept only JSON values, without silently dropping or converting input.
function jsonValue(
  value: unknown,
  ancestors = new Set<object>(),
  path = "data",
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value))
    throw new TypeError(
      `${path} must contain only JSON values (no cycles or non-finite numbers).`,
    );
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    throw new TypeError(
      `${path} must be a plain JSON object; convert dates to strings.`,
    );
  ancestors.add(value);
  const keys = Reflect.ownKeys(value).filter(
    (key) => !(array && key === "length"),
  );
  if (array && keys.length !== value.length)
    throw new TypeError(`${path} must be a dense JSON array.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      key,
    ) as PropertyDescriptor;
    if (
      typeof key !== "string" ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      (array && !/^(0|[1-9][0-9]*)$/.test(key))
    )
      throw new TypeError(
        `${path} must contain only ordinary JSON properties.`,
      );
    jsonValue(descriptor.value, ancestors, `${path}.${key}`);
  }
  ancestors.delete(value);
}

// How long a request may go unanswered before it fails as UNAVAILABLE. Naru
// answers or refuses within about ten seconds, so a request still waiting
// after this is one that will not arrive: a page can say so instead of
// waiting on the browser's own limit, which can be minutes.
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The types Naru Media stores (the server refuses others), for a page that
 * checks a file before uploading it. Site code reads them as ctx.media.types.
 */
export const MEDIA_TYPES: readonly string[] = Object.freeze([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "application/pdf",
  "application/zip",
  "text/plain",
]);

let sessionId: string | undefined;
/**
 * This browser's session (ctx.session in the site's code): a random ID kept
 * in its storage and sent with queries and mutations. It names a browser,
 * never a person, and goes where storage is cleared.
 */
function browserSession(): string {
  if (sessionId) return sessionId;
  try {
    sessionId = localStorage.getItem("naru-session") ?? undefined;
  } catch {
    // No storage: this page's own ID.
  }
  if (!sessionId || !/^[A-Za-z0-9_-]{16,64}$/.test(sessionId)) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    sessionId = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    try {
      localStorage.setItem("naru-session", sessionId);
    } catch {
      // Kept for this page only.
    }
  }
  return sessionId;
}

async function request<Result>(
  url: string,
  {
    method = "GET",
    body,
    token,
    signal,
    touches,
    renew,
    session = false,
  }: Transport,
): Promise<Result> {
  const fresh =
    token || method !== "GET" || touches.some((path) => written.has(path));
  // An explicit transport flag makes cache bypass enforceable by the server.
  if (fresh && method === "GET") {
    const target = new URL(url);
    target.searchParams.set("fresh", "1");
    url = target.href;
  }
  // Serialization errors are input errors, never network failures.
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  let response;
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    response = await fetch(url, {
      method,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      credentials: "omit",
      redirect: "error",
      cache: fresh ? "no-store" : "default",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(session ? { "Naru-Session": browserSession() } : {}),
      },
      body: encoded,
    });
  } catch (cause) {
    // The caller's own abort; a timeout (TimeoutError) is Naru's silence.
    if ((cause as Error)?.name === "AbortError") throw cause;
    throw naruError(
      "UNAVAILABLE",
      (cause as Error)?.name === "TimeoutError"
        ? "Naru did not answer in time."
        : "Naru is unavailable.",
      { cause },
    );
  } finally {
    // Also when the response was lost: the write may still have landed.
    if (method !== "GET") for (const path of touches) written.add(path);
  }
  // A token's lifetime is an idle window the server pushes forward as the
  // token is used, and this is the expiry it now has. It arrives as a duration
  // so this browser's clock, however wrong, only measures it.
  const renewed = response.headers.get("Naru-Owner-Expires-In");
  if (renew && renewed !== null && Number.isFinite(Number(renewed)))
    renew(Date.now() + Number(renewed) * 1000);
  const result = await response.json().catch(() => null);
  if (!response.ok) throw failure(response.status, result?.error);
  // A proxy or challenge page can answer 200 with HTML. Handing that back as
  // an empty result would make a missing document look like a present one.
  if (result === null || typeof result !== "object")
    throw naruError(
      "UNAVAILABLE",
      `The data API did not answer with JSON (HTTP ${response.status}).`,
    );
  return result;
}

function query({
  filter,
  sort,
  size,
  after,
  includeTotal,
}: ListOptions = {}): string {
  const parameters = new URLSearchParams();
  if (filter && Object.keys(filter).length)
    parameters.set("filter", JSON.stringify(filter));
  if (sort) parameters.set("sort", JSON.stringify(sort));
  if (size !== undefined) parameters.set("size", String(size));
  if (after) parameters.set("after", after);
  if (includeTotal) parameters.set("includeTotal", "1");
  const text = String(parameters);
  return text ? `?${text}` : "";
}

// Shared by single writes and batches, so both refuse the same mistakes here.
// A delete conditional on absence could only ever do nothing.
function checkCondition(
  value: WriteCondition | undefined,
  { deleting = false } = {},
): WriteCondition | undefined {
  if (value === undefined) return value;
  if (!value || typeof value !== "object")
    throw new TypeError("condition must contain revision or absent.");
  if (Object.keys(value).length !== 1)
    throw new TypeError("condition must contain only revision or absent.");
  if (Object.hasOwn(value, "revision")) {
    const { revision } = value as { revision: unknown };
    if (typeof revision !== "string" || !revision)
      throw new TypeError("condition.revision must be returned by Naru.");
    return value;
  }
  if ((value as { absent?: unknown }).absent === true && !deleting)
    return value;
  throw new TypeError(
    deleting
      ? "A delete can only be conditional on a revision."
      : "condition must contain revision or absent.",
  );
}

function condition(
  value: WriteCondition | undefined,
  options?: { deleting?: boolean },
): string {
  checkCondition(value, options);
  if (value === undefined) return "";
  const { revision } = value as { revision?: Revision };
  return revision
    ? `?ifRevision=${encodeURIComponent(revision)}`
    : "?ifAbsent=1";
}

function documents<T>(
  root: string,
  name: string,
  send: Send,
): AdminCollection<T> {
  const path = `${root}/${segment(name)}`;
  const touches = [path];
  const list: AdminCollection<T>["list"] = (options = {}) =>
    send(`${path}${query(options)}`, { signal: options.signal, touches });
  return Object.freeze({
    async get(id: string, { signal }: { signal?: AbortSignal } = {}) {
      const result = await send<{ document: Document<T> }>(
        `${path}/${segment(id)}`,
        { signal, touches },
      );
      return result.document;
    },
    list,
    // A total rides along with a one-document page; the list request is all
    // the server needs to support.
    async count({
      filter,
      signal,
    }: { filter?: Filter; signal?: AbortSignal } = {}) {
      return (await list({ filter, size: 1, includeTotal: true, signal }))
        .totalCount as number;
    },
    // Each page as it arrives, following nextCursor. Like the pages it walks,
    // this is not a snapshot: writes in between can shift later pages.
    async *pages(options: ListOptions = {}) {
      let after = options.after;
      do {
        const page = await list({ ...options, after });
        yield page;
        after = page.nextCursor;
      } while (after);
    },
    add(data: T, { signal }: { signal?: AbortSignal } = {}) {
      jsonValue(data);
      return send<Document<T>>(path, {
        method: "POST",
        body: { data },
        signal,
        touches,
      });
    },
    set(
      id: string,
      data: T,
      {
        signal,
        condition: expected,
      }: { condition?: WriteCondition; signal?: AbortSignal } = {},
    ) {
      jsonValue(data);
      return send<Document<T>>(`${path}/${segment(id)}${condition(expected)}`, {
        method: "PUT",
        body: { data },
        signal,
        touches,
      });
    },
    async delete(
      id: string,
      {
        signal,
        condition: expected,
      }: { condition?: { revision: Revision }; signal?: AbortSignal } = {},
    ) {
      await send(
        `${path}/${segment(id)}${condition(expected, { deleting: true })}`,
        { method: "DELETE", signal, touches },
      );
    },
  });
}

/** A collection of the site this page belongs to. Nothing is requested yet. */
function publicDocuments<T>(root: string, name: string): PublicCollection<T> {
  const collection = documents<T>(root, name, request);
  return Object.freeze({
    get: collection.get,
    list: collection.list,
    count: collection.count,
    pages: collection.pages,
    add: collection.add,
  });
}

// Photos straight off a phone are several megabytes and thousands of pixels
// for an image a page shows at a fraction of that. Uploads go straight to
// object storage, so the browser is the only place to shrink them: before the
// upload is authorized, so quota counts what is stored, and by re-encoding,
// which drops EXIF so a photo's location never reaches the public URL.
const MAX_EDGE = 2048;
// Naru never stores HEIC, so a photo in it is converted or refused here. The
// other types Naru stores are the server's to say, and may grow.
const HEIC = /^image\/hei[cf]$/;
const HEIC_NAME = /\.hei[cf]$/i;
const SMALL_BYTES = 512 * 1024;
async function shrink(file: Source): Promise<Source> {
  const heic = HEIC.test(file.type);
  if (
    !(heic || /^image\/(jpeg|png|webp)$/.test(file.type)) ||
    typeof createImageBitmap !== "function"
  )
    return file;
  let bitmap;
  try {
    // Canvas discards EXIF, so orientation is baked into the pixels here.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && !heic && file.size <= SMALL_BYTES) return file;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    for (const type of ["image/webp", "image/jpeg"]) {
      const canvas =
        typeof OffscreenCanvas === "function"
          ? new OffscreenCanvas(width, height)
          : Object.assign(document.createElement("canvas"), { width, height });
      // Spelled out: which overload a union of canvases resolves to depends on
      // what else a program compiles, and the application's does differ.
      const context = canvas.getContext("2d") as
        OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
      if (!context) return file;
      // JPEG has no transparency; paint white rather than let it go black.
      if (type === "image/jpeg") {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await ("convertToBlob" in canvas
        ? canvas.convertToBlob({ type, quality: 0.82 })
        : new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, type, 0.82),
          ));
      // A browser that cannot encode a type quietly returns PNG instead.
      if (blob?.type !== type) continue;
      // HEIC is not accepted as is, so its conversion is kept even if larger.
      if (!heic && blob.size >= file.size) return file;
      const base = (file.name || "upload").replace(/\.[^.]*$/, "");
      return new File([blob], `${base}.${type.slice(6)}`, { type });
    }
    return file;
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}

// The bytes go from the browser straight to object storage on a signed URL.
// fetch reports nothing of a body it sends, and streaming one to count it
// would drop the Content-Length a signed PUT needs, so a caller who asked for
// progress gets the same PUT through XMLHttpRequest. It answers like fetch:
// { ok, status }, a TypeError for a network failure, and the signal's reason
// for an abort.
function put(
  url: string,
  headers: Record<string, string>,
  file: Blob,
  signal: AbortSignal | undefined,
  uploading: ((loaded: number) => void) | undefined,
): Promise<{ ok: boolean; status: number }> {
  if (!uploading)
    return fetch(url, {
      method: "PUT",
      headers,
      body: file,
      signal,
      credentials: "omit",
      redirect: "error",
    });
  return new Promise((resolve, reject) => {
    const aborted = () =>
      signal?.reason ??
      new DOMException("The upload was aborted.", "AbortError");
    if (signal?.aborted) return reject(aborted());
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const settle = (finish: () => void) => {
      signal?.removeEventListener("abort", abort);
      finish();
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.open("PUT", url);
    for (const [name, value] of Object.entries(headers))
      request.setRequestHeader(name, value);
    request.upload.onprogress = (event) =>
      uploading(Math.min(event.loaded, file.size));
    // XMLHttpRequest follows redirects it cannot be told to refuse. Storage
    // never redirects a signed upload, so one that moved is not trusted.
    request.onload = () =>
      settle(() =>
        resolve({
          ok:
            request.status >= 200 &&
            request.status < 300 &&
            request.responseURL === new URL(url).href,
          status: request.status,
        }),
      );
    request.onerror = request.ontimeout = () =>
      settle(() => reject(new TypeError("The upload connection failed.")));
    request.onabort = () => settle(() => reject(aborted()));
    request.send(file);
    // After send: an abort from this first report must reach a sent request,
    // which fires abort, rather than an unsent one, which would not.
    uploading(0);
  });
}

// Uploading, as an owner or a member: the same requests, with the token the
// handle sends them with.
function media(root: string, send: Send): Admin["media"] {
  return Object.freeze({
    async delete(id: string, { signal }: { signal?: AbortSignal } = {}) {
      if (signal?.aborted)
        throw (
          signal.reason ??
          new DOMException("The deletion was aborted.", "AbortError")
        );
      if (
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      )
        throw new TypeError("media.delete() needs an uploaded file ID.");
      await send(`${root}/_files/${id}`, {
        method: "DELETE",
        signal,
        touches: [],
      });
    },
    async upload(
      source: Source,
      {
        signal,
        onProgress,
      }: {
        signal?: AbortSignal;
        onProgress?: (
          progress:
            | { phase: "preparing" }
            | { phase: "uploading"; loaded: number; total: number }
            | { phase: "finishing" },
        ) => void;
      } = {},
    ) {
      if (onProgress !== undefined && typeof onProgress !== "function")
        throw new TypeError("onProgress must be a function.");
      // A caller's mistake in its progress handler is reported, never
      // allowed to fail an upload partway through.
      const report = (
        progress: Parameters<NonNullable<typeof onProgress>>[0],
      ) => {
        try {
          onProgress?.(progress);
        } catch (error) {
          if (typeof reportError === "function") reportError(error);
          else
            setTimeout(() => {
              throw error;
            });
        }
      };
      report({ phase: "preparing" });
      // Some browsers leave an iPhone photo's type empty.
      const file = await shrink(
        !source.type && HEIC_NAME.test(source.name ?? "")
          ? new File([source], source.name as string, { type: "image/heic" })
          : source,
      );
      if (HEIC.test(file.type))
        throw new TypeError(
          "This browser cannot convert HEIC photos. Upload from Safari, or convert the photo to JPEG first.",
        );
      const authorization = await send<Authorization>(`${root}/_files`, {
        method: "POST",
        body: {
          name: file.name || "upload",
          contentType: file.type,
          size: file.size,
        },
        signal,
        touches: [],
      });
      let upload;
      try {
        upload = await put(
          authorization.uploadUrl,
          authorization.headers,
          file,
          signal,
          onProgress &&
            ((loaded) =>
              report({ phase: "uploading", loaded, total: file.size })),
        );
      } catch (cause) {
        if ((cause as Error)?.name === "AbortError") throw cause;
        throw naruError("UNAVAILABLE", "File upload failed.", {
          words: "파일을 올리지 못했습니다. 다시 해 주세요.",
          cause,
        });
      }
      // An upload that never finishes is removed by the server within an
      // hour. Storage refusing the bytes (an expired authorization, say) is
      // fixed by uploading again, which authorizes afresh.
      if (!upload.ok)
        throw naruError(
          "UNAVAILABLE",
          `File upload failed (HTTP ${upload.status}).`,
          { words: "파일을 올리지 못했습니다. 다시 해 주세요." },
        );
      report({ phase: "finishing" });
      const finished = await send<Stored>(
        `${root}/_files/${segment(authorization.id)}`,
        { method: "PUT", body: {}, signal, touches: [] },
      );
      // What was stored, which shrinking may have renamed and re-encoded.
      const { url, name, contentType, size } = finished.file;
      return { id: authorization.id, url, name, contentType, size };
    },
  });
}

// Where a session is kept. An owner's lives in one tab, for the callback
// page it signed in on; a member's in the site's local storage, for every
// page and tab of the site. A sign-in in progress is the tab's either way.
interface Place {
  store: () => Storage;
  key: string;
}
const ownerPlace = ({ origin, site }: Context): Place => ({
  store: () => sessionStorage,
  key: `naru:owner:${origin}:${site}:${location.origin}${location.pathname}`,
});
const memberPlace = ({ origin, site }: Context): Place => ({
  store: () => localStorage,
  key: `naru:member:${origin}:${site}`,
});

function saved({ store, key }: Place): Session | null {
  try {
    return JSON.parse(store().getItem(key) ?? "null");
  } catch {
    return null; /* unreadable or blocked, so no session */
  }
}

// An older client must not erase or outlive a newer sign-in made in the same
// place, so both of these only touch a stored session that is still this one.
function forget(place: Place, token: string): void {
  try {
    if (saved(place)?.accessToken === token)
      place.store().removeItem(place.key);
  } catch {
    /* storage blocked: nothing was kept */
  }
}

function remember(place: Place, token: string, expiresAt: number): void {
  const session = saved(place);
  try {
    if (session?.accessToken === token)
      place
        .store()
        .setItem(place.key, JSON.stringify({ ...session, expiresAt }));
  } catch {
    /* storage blocked: the handle still holds it */
  }
}

// What an owner's and a member's handle share: a token the server renews as
// it is used, so a tab left open while it is used is not signed out midway,
// and which the handle refuses to send once signed out or expired.
function credential(place: Place, token: string, expiresAt: number) {
  const renew = (at: number) => {
    if (!(at > expiresAt)) return;
    expiresAt = at;
    remember(place, token, at);
  };
  let signedOut = false;
  const send: Send = async <Result>(
    url: string,
    init: Omit<Transport, "token" | "renew">,
  ) => {
    if (signedOut || Date.now() >= expiresAt) {
      forget(place, token);
      throw naruError("AUTH_REQUIRED", "Sign in again.");
    }
    try {
      return await request<Result>(url, { ...init, token, renew });
    } catch (error) {
      if ((error as NaruError).code === "AUTH_REQUIRED") forget(place, token);
      throw error;
    }
  };
  /** Forgets the session here first, then asks Naru to revoke it. */
  const signOut = async (revoke: string) => {
    signedOut = true;
    forget(place, token);
    await request(revoke, { method: "POST", token, touches: [] });
  };
  return { send, signOut };
}

// A mistake in an application's callback is reported, never allowed to break
// the SDK work that called it.
function guarded<A extends unknown[]>(
  fn: ((...args: A) => void) | undefined,
  ...args: A
) {
  try {
    fn?.(...args);
  } catch (error) {
    if (typeof reportError === "function") reportError(error);
    else
      setTimeout(() => {
        throw error;
      });
  }
}

// A live connection to the site's object, through the edge, which carries a
// handle's live queries (`subscriptions`). It reconnects with growing pauses
// while the network or the site is away, and stops for good when closed, or
// when the server ends the member's access (4003). A member's connection
// opens with a fresh ticket each time (`ticket`).
type LiveHooks = {
  open(send: (message: unknown) => void): void;
  message(message: unknown): void;
  closed(): void;
};

function live(
  root: string,
  hooks: LiveHooks,
  ticket?: () => Promise<string>,
): Live {
  let socket: WebSocket | undefined;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(keepalive);
  };
  const retry = () => {
    if (closed) return;
    const pause = Math.min(30_000, 1000 * 2 ** attempt++);
    timer = setTimeout(open, pause / 2 + (Math.random() * pause) / 2);
  };
  async function open() {
    if (closed) return;
    const url = new URL(`${root}/_live`);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    if (ticket)
      try {
        url.searchParams.set("ticket", await ticket());
      } catch (error) {
        const code = (error as NaruError).code;
        if (code === "AUTH_REQUIRED" || code === "ACCESS_DENIED") stop();
        else retry();
        return;
      }
    if (closed) return;
    const current = new WebSocket(url);
    socket = current;
    current.onopen = () => {
      attempt = 0;
      // Answered by the server without waking the site's object.
      keepalive = setInterval(() => current.send("ping"), 50_000);
      hooks.open((message) => current.send(JSON.stringify(message)));
    };
    current.onmessage = (event) => {
      if (event.data === "pong") return;
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      hooks.message(message);
    };
    current.onclose = (event) => {
      clearInterval(keepalive);
      hooks.closed();
      if (socket === current) socket = undefined;
      if (closed) return;
      if (event.code === 4003) stop();
      else retry();
    };
  }
  void open();
  return Object.freeze({
    close() {
      if (closed) return;
      stop();
      socket?.close(1000);
    },
  });
}

// Live queries: one connection a handle shares among them, opened with the
// first and closed with the last. On every (re)connect each is asked again,
// so a result missed while the connection was down arrives then.
function subscriptions(root: string, ticket?: () => Promise<string>) {
  const active = new Map<
    string,
    {
      query: string;
      args: Json;
      onResult(result: never): void;
      onError?(error: NaruError): void;
    }
  >();
  let connection: Live | undefined;
  let send: ((message: unknown) => void) | undefined;
  let next = 0;
  const ask = (id: string) => {
    const { query, args } = active.get(id)!;
    send?.({ type: "subscribe", id, query, args });
  };
  return function subscribe<R = Json>(
    name: string,
    given: Json | undefined,
    onResult: (result: R) => void,
    options: { onError?(error: NaruError): void } = {},
  ): Live {
    const parts = typeof name === "string" ? name.split(":") : [];
    if (parts.length !== 2)
      throw new TypeError('Live queries name "<module/path>:<query>".');
    parts[0].split("/").forEach(segment);
    segment(parts[1]);
    // As query()'s default: no args is null, not a refusal.
    const args = given === undefined ? null : given;
    jsonValue(args, undefined, "args");
    if (typeof onResult !== "function")
      throw new TypeError("subscribe() needs an onResult function.");
    const id = String(++next);
    active.set(id, {
      query: name,
      args,
      onResult: onResult as (result: never) => void,
      onError: options.onError,
    });
    connection ??= live(
      root,
      {
        open(sender) {
          send = sender;
          for (const id of active.keys()) ask(id);
        },
        message(message) {
          const { type, id, result, error } = (message ?? {}) as {
            type?: string;
            id?: string;
            result?: never;
            error?: {
              status: number;
              code?: string;
              message?: string;
              details?: Json;
              site?: boolean;
            };
          };
          const subscription = id === undefined ? undefined : active.get(id);
          if (type === "result" && subscription)
            guarded(subscription.onResult, result!);
          else if (type === "error" && subscription)
            guarded(subscription.onError, failure(error?.status ?? 400, error));
        },
        closed() {
          send = undefined;
        },
      },
      ticket,
    );
    ask(id);
    return Object.freeze({
      close() {
        if (!active.delete(id)) return;
        send?.({ type: "unsubscribe", id });
        if (active.size) return;
        connection?.close();
        connection = undefined;
        send = undefined;
      },
    });
  };
}

// Running a query or mutation, as a visitor, a member or the owner: the same
// request with the handle's token, if it has one. Queries and mutations write
// the site's tables, not collections, so no collection's cache is touched.
function siteCode(root: string, send: Send, path: "_query" | "_mutate") {
  return async function call<R = Json>(
    name: string,
    args: Json = null,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<R> {
    const parts = typeof name === "string" ? name.split(":") : [];
    if (parts.length !== 2)
      throw new TypeError('Calls name "<module/path>:<export>".');
    parts[0].split("/").forEach(segment);
    segment(parts[1]);
    jsonValue(args, undefined, "args");
    const answer = await send<{ result: R }>(
      `${root}/${path}/${parts[0]}:${parts[1]}`,
      { method: "POST", body: { args }, signal, touches: [], session: true },
    );
    return answer.result;
  };
}

function admin(context: Context, token: string, expiresAt: number): Admin {
  const { origin, root } = context;
  const { send, signOut } = credential(ownerPlace(context), token, expiresAt);
  return Object.freeze({
    collection: <T = Json>(name: string) => documents<T>(root, name, send),
    async batch(
      writes: readonly BatchWrite[],
      { signal }: { signal?: AbortSignal } = {},
    ) {
      const operations = writes.map(({ collection, set, delete: remove }) => {
        const write = set ?? remove;
        if (!write || Boolean(set) === Boolean(remove))
          throw new TypeError("Each batch write must set or delete.");
        if (set) jsonValue(set.data);
        segment(collection);
        segment(write.id);
        checkCondition(write.condition, { deleting: !set });
        return {
          type: set ? "set" : "delete",
          collection,
          id: write.id,
          ...(set ? { data: set.data } : {}),
          ...(write.condition ? { condition: write.condition } : {}),
        };
      });
      const touches = [
        ...new Set(operations.map((item) => `${root}/${item.collection}`)),
      ];
      const { results } = await send<{ results: (Written | null)[] }>(
        `${root}/_batch`,
        {
          method: "POST",
          body: { operations },
          signal,
          touches,
        },
      );
      // In the order written: what each set stored, and null for a delete.
      return results.map((result) =>
        result
          ? {
              id: result.id,
              revision: result.revision,
              createdAt: result.createdAt,
              updatedAt: result.updatedAt,
            }
          : null,
      );
    },
    query: siteCode(root, send, "_query"),
    mutate: siteCode(root, send, "_mutate"),
    subscribe: subscriptions(root, async () => {
      const { ticket } = await send<{ ticket: string }>(`${root}/_live`, {
        method: "POST",
        body: {},
        touches: [],
      });
      return ticket;
    }),
    media: media(root, send),
    signOut: () => signOut(`${origin}/api/data-auth/v1/revoke`),
  });
}

function member(
  context: Context,
  token: string,
  expiresAt: number,
  id: string,
): Member {
  const { origin, root } = context;
  const { send, signOut } = credential(memberPlace(context), token, expiresAt);
  const liveTicket = async () => {
    const { ticket } = await send<{ ticket: string }>(`${root}/_live`, {
      method: "POST",
      body: {},
      touches: [],
    });
    return ticket;
  };
  return Object.freeze({
    id,
    query: siteCode(root, send, "_query"),
    mutate: siteCode(root, send, "_mutate"),
    subscribe: subscriptions(root, liveTicket),
    media: media(root, send),
    signOut: () => signOut(`${origin}/api/data-auth/v1/member-revoke`),
  });
}

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
// The page this tab is at. Naru sends the sign-in back to it, so the session
// below is found where it was left; the rest of the address is restored then.
const callback = () => location.origin + location.pathname;

/**
 * Leaves for Naru's approval page at `path` with `query`, keeping what it
 * takes to finish when Naru sends the tab back.
 */
async function leave(
  context: Context,
  place: Place,
  path: string,
  query: Record<string, string>,
): Promise<void> {
  const verifier = random();
  const state = random();
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  // The PKCE transaction has to survive the round trip through Naru.
  sessionStorage.setItem(
    `${place.key}:pending`,
    JSON.stringify({
      verifier,
      state,
      startedAt: Date.now(),
      address: location.href,
    }),
  );
  const approval = new URL(path, context.origin);
  approval.search = String(
    new URLSearchParams({
      site: context.site,
      redirectUri: callback(),
      challenge,
      state,
      ...query,
    }),
  );
  location.assign(approval.href);
}

/**
 * Leaves for Naru, where the owner approves access to `collections`, and comes
 * back to this page. Register this page's URL as an administrator callback in
 * the control panel first; Naru says so on its own page if it is not.
 */
async function signIn(
  context: Context,
  collections: readonly string[],
  mediaDelete = false,
): Promise<void> {
  if (typeof mediaDelete !== "boolean")
    throw new TypeError("mediaDelete must be a boolean.");
  // Checked here so a bad name fails on this page, not on Naru's consent page.
  collections.forEach(segment);
  await leave(context, ownerPlace(context), "/database/authorize", {
    collections: collections.join(","),
    ...(mediaDelete ? { mediaDelete: "1" } : {}),
  });
}

/**
 * The token Naru's redirect back to this page carries, or null when this is
 * not that redirect: then the page's own `?code=`, `?error=` and `?state=`
 * are left alone. Only the sign-in this tab started in `place`, with the same
 * state, is finished, so an owner's and a member's sign-in never take each
 * other's code.
 */
async function returned(
  context: Context,
  place: Place,
  exchange: string,
): Promise<Token | null> {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const denied = url.searchParams.get("error");
  const state = url.searchParams.get("state");
  let pending: Pending | null = null;
  try {
    pending = JSON.parse(
      sessionStorage.getItem(`${place.key}:pending`) ?? "null",
    );
  } catch {
    /* unreadable, so no sign-in to finish */
  }
  if (!pending || pending.state !== state || (code === null && denied === null))
    return null;
  for (const name of ["code", "state", "error"]) url.searchParams.delete(name);
  // Back to the address the sign-in left from, when that is this page.
  const left = pending.address ? new URL(pending.address) : null;
  history.replaceState(
    history.state,
    "",
    left && left.origin + left.pathname === url.origin + url.pathname
      ? left.href
      : url.href,
  );
  sessionStorage.removeItem(`${place.key}:pending`);
  if (!(Date.now() - pending.startedAt < 10 * 60 * 1000))
    throw naruError("AUTH_REQUIRED", "Sign-in expired.", {
      words: "로그인 시간이 지났습니다. 다시 로그인해 주세요.",
    });
  if (denied !== null)
    throw naruError("ACCESS_DENIED", "Sign-in was denied.", {
      words: "로그인하지 않았습니다.",
    });
  const startedAt = Date.now();
  const token = await request<Token>(`${context.origin}${exchange}`, {
    method: "POST",
    body: { code, verifier: pending.verifier, redirectUri: callback() },
    touches: [],
  });
  // The lifetime is measured on this browser's clock from before the request,
  // so a clock set wrong can neither end the session early nor extend it.
  return {
    ...token,
    expiresAt: Number.isFinite(token.expiresIn)
      ? startedAt + (token.expiresIn as number) * 1000
      : token.expiresAt,
  };
}

/**
 * The signed-in admin client for this page, or null. Finishes a sign-in when
 * Naru has just redirected back, and otherwise restores this tab's session.
 * Call it before rendering: it removes the one-time code from the address bar.
 *
 * A sign-in that came back without completing (denied, stale, or a failed
 * exchange) is an ordinary signed-out visit, never a page failure. The owner
 * who denied it knows; anything else is fixed by signing in again.
 */
async function adminSession(context: Context): Promise<Admin | null> {
  const place = ownerPlace(context);
  try {
    const token = await returned(context, place, "/api/data-auth/v1/token");
    if (token) {
      place.store().setItem(
        place.key,
        JSON.stringify({
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
        }),
      );
      return admin(context, token.accessToken, token.expiresAt);
    }
  } catch (error) {
    if (error instanceof NaruError) return null;
    throw error;
  }
  const session = saved(place);
  if (session && session.expiresAt > Date.now())
    return admin(context, session.accessToken, session.expiresAt);
  place.store().removeItem(place.key);
  return null;
}

/**
 * The member signed in to this site, or null, like `adminSession`: from
 * Naru's redirect back, or from the site's storage.
 */
async function memberSession(context: Context): Promise<Member | null> {
  const place = memberPlace(context);
  try {
    const token = await returned(
      context,
      place,
      "/api/data-auth/v1/member-token",
    );
    if (token) {
      const id = token.memberId as string;
      try {
        place.store().setItem(
          place.key,
          JSON.stringify({
            accessToken: token.accessToken,
            expiresAt: token.expiresAt,
            memberId: id,
          }),
        );
      } catch {
        /* storage blocked: signed in on this page only */
      }
      return member(context, token.accessToken, token.expiresAt, id);
    }
  } catch (error) {
    if (error instanceof NaruError) return null;
    throw error;
  }
  const session = saved(place);
  if (session?.memberId && session.expiresAt > Date.now())
    return member(
      context,
      session.accessToken,
      session.expiresAt,
      session.memberId,
    );
  try {
    place.store().removeItem(place.key);
  } catch {
    /* storage blocked: nothing was kept */
  }
  return null;
}

/** Creates a client bound to one site. */
export function createNaru(options?: { site?: string }): NaruClient {
  const context = target(options);
  return Object.freeze({
    collection: <T = Json>(name: string) =>
      publicDocuments<T>(context.root, name),
    subscribe: subscriptions(context.root),
    query: siteCode(context.root, request, "_query"),
    mutate: siteCode(context.root, request, "_mutate"),
    auth: Object.freeze({
      session: () => adminSession(context),
      signIn: ({
        collections = [],
        mediaDelete,
      }: {
        collections?: readonly string[];
        mediaDelete?: boolean;
      } = {}) => signIn(context, collections, mediaDelete),
    }),
    members: Object.freeze({
      session: () => memberSession(context),
      signIn: () =>
        leave(context, memberPlace(context), "/members/sign-in", {}),
    }),
  });
}
