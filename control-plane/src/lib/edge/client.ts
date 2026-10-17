import { DataError, type ErrorCode } from "@/lib/site-data/validation";

// The control plane's client for the edge Worker (edge/ at the repository
// root), reached over HTTPS with a shared secret: operations on a site's
// Durable Object, the pageview log, and the custom domain table.
//
// Site objects run on the mini: the same Worker under workerd beside this
// control plane (edge/src/seoul.ts), at SITE_DATA_URL. Pageviews and custom
// domains belong to the hosted pages, which stay on Cloudflare at
// EDGE_WORKER_URL. Local runs and tests have one Worker, at EDGE_WORKER_URL,
// for both (edge/src/local.ts).

const WORKER_TIMEOUT_MS = 10_000;

const unavailable = () =>
  new DataError(
    503,
    "The site database is unavailable. Try again shortly.",
    "UNAVAILABLE",
  );

/**
 * Calls one operation on a site's object. A refusal the object made arrives
 * as the DataError it threw; anything else the Worker answers is logged and
 * reported as unavailable. `timeoutMs` lets a long operation, such as a
 * restore, wait longer than WORKER_TIMEOUT_MS.
 */
export function callSiteObject<T>(
  site: string,
  operation: string,
  input: unknown,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  return callWorker<T>(
    `/v1/sites/${encodeURIComponent(site)}/${operation}`,
    `${operation} on ${site}`,
    input,
    signal,
    siteDataWorker(),
    timeoutMs,
  );
}

/** A Worker that holds site objects, and the secret it takes. */
export type WorkerTarget = { base?: string; secret?: string };
/** Where the edge Worker runs on Cloudflare: hosted pages and their logs. */
export const edgeWorker = (): WorkerTarget => ({
  base: process.env.EDGE_WORKER_URL,
  secret: process.env.EDGE_WORKER_SECRET,
});
/**
 * Where site objects live: the mini's workerd at SITE_DATA_URL, or, where
 * that is not set (local runs and tests), the one local Worker.
 */
export const siteDataWorker = (): WorkerTarget =>
  process.env.SITE_DATA_URL
    ? {
        base: process.env.SITE_DATA_URL,
        secret: process.env.SITE_DATA_SECRET ?? process.env.EDGE_WORKER_SECRET,
      }
    : edgeWorker();

/**
 * How long the edge may rely on what a sync last told it: a site's paid
 * status, and the custom domain table. Each sync renews it.
 */
export const CONFIRMATION_MS = 3 * 24 * 60 * 60 * 1000;

/** Replaces the edge's custom domain table (edge/src/domains.ts). */
export function replaceEdgeDomains(table: {
  confirmedUntil: number;
  domains: Record<string, { login: string; entitledUntil: number | null }>;
}) {
  return callWorker<null>("/v1/domains/replace", "domain table", table);
}

/** Calls one operation on the edge's pageview log (pageview-log.ts). */
export function callPageviewLog<T>(operation: string, input: unknown) {
  return callWorker<T>(
    `/v1/pageviews/${operation}`,
    `pageview ${operation}`,
    input,
  );
}

async function callWorker<T>(
  path: string,
  what: string,
  input: unknown,
  signal?: AbortSignal,
  target: WorkerTarget = edgeWorker(),
  timeoutMs = WORKER_TIMEOUT_MS,
): Promise<T> {
  const response = await requestWorker(
    target,
    path,
    what,
    { body: JSON.stringify(input), contentType: "application/json" },
    signal,
    timeoutMs,
  );
  return answerOf<T>(response, what);
}

/**
 * POSTs `body` to the Worker at `target`; a stream is sent as it is read.
 * Returns its response, whatever its status, or throws unavailable when it
 * cannot be reached. The timeout covers reading the response too.
 */
export async function requestWorker(
  { base, secret }: WorkerTarget,
  path: string,
  what: string,
  { body, contentType }: { body: BodyInit; contentType: string },
  signal?: AbortSignal,
  timeoutMs = WORKER_TIMEOUT_MS,
): Promise<Response> {
  if (!base || !secret) {
    console.error(`No Worker URL or secret for ${what}`);
    throw unavailable();
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(new URL(path, base), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": contentType,
      },
      body,
      // A stream body is sent as it is read (Node's fetch needs this).
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    } as RequestInit);
  } catch (error) {
    // The caller canceled: http.ts reports that itself.
    if (signal?.aborted) throw error;
    console.error(`Edge Worker unreachable for ${what}`, error);
    throw unavailable();
  }
}

/** A Worker's JSON answer: its `value`, or the DataError it refused with. */
export async function answerOf<T>(
  response: Response,
  what: string,
): Promise<T> {
  const body = (await response.json().catch(() => null)) as {
    value?: T;
    error?: {
      status: number;
      message: string;
      code?: ErrorCode;
      details?: unknown;
      site?: boolean;
    };
  } | null;
  if (response.ok && body && "value" in body) return body.value as T;
  if (body?.error && body.error.status === response.status)
    throw new DataError(
      body.error.status,
      body.error.message,
      body.error.code,
      body.error.details,
      body.error.site,
    );
  console.error(`Edge Worker answered ${response.status} to ${what}`);
  throw unavailable();
}

/** Erases a deleted account's site database. */
export async function eraseSiteData(site: string) {
  await callSiteObject(site, "erase", {});
}
