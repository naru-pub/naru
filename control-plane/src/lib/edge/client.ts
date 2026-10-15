import { DataError, type ErrorCode } from "@/lib/site-data/validation";

// The control plane's client for the edge Worker (edge/ at the repository
// root), reached over HTTPS with a shared secret: operations on a site's
// Durable Object, the pageview log, and the custom domain table.
//
// Site objects can run elsewhere than Cloudflare: the same Worker under
// workerd beside this control plane (edge/src/seoul.ts), at SITE_DATA_URL.
// Pageviews and custom domains belong to the hosted pages, which stay on
// Cloudflare at EDGE_WORKER_URL.

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
 * reported as unavailable.
 */
export function callSiteObject<T>(
  site: string,
  operation: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return callSiteObjectAt<T>(
    siteDataWorker(site),
    site,
    operation,
    input,
    signal,
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
 * Where a site's object lives: the mini's workerd when SITE_DATA_URL is set,
 * else Cloudflare. SITE_DATA_SITES, when set, names the only sites moved so
 * far (comma-separated), as during a rehearsal; the rest stay on Cloudflare.
 */
export const siteDataWorker = (site?: string): WorkerTarget => {
  const moved = process.env.SITE_DATA_SITES?.split(",").map((s) => s.trim());
  return process.env.SITE_DATA_URL &&
    (!moved || (site !== undefined && moved.includes(site)))
    ? {
        base: process.env.SITE_DATA_URL,
        secret: process.env.SITE_DATA_SECRET ?? process.env.EDGE_WORKER_SECRET,
      }
    : edgeWorker();
};

/** callSiteObject on a given Worker, for moving a site between two. */
export function callSiteObjectAt<T>(
  target: WorkerTarget,
  site: string,
  operation: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return callWorker<T>(
    `/v1/sites/${encodeURIComponent(site)}/${operation}`,
    `${operation} on ${site}`,
    input,
    signal,
    target,
  );
}

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

/**
 * Tells the standby's health check on Cloudflare that the mini is up, with
 * each site's counts there (edge/src/standby.ts, lib/edge/standby.ts).
 */
export function sendStandbyHeartbeat(input: {
  sites: Record<string, { collections: number; documents: number }>;
}) {
  return callWorker<null>("/v1/standby/heartbeat", "standby heartbeat", input);
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
  { base, secret }: WorkerTarget = edgeWorker(),
): Promise<T> {
  if (!base || !secret) {
    console.error(`No Worker URL or secret for ${what}`);
    throw unavailable();
  }
  const timeout = AbortSignal.timeout(WORKER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(new URL(path, base), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    // The caller canceled: http.ts reports that itself.
    if (signal?.aborted) throw error;
    console.error(`Edge Worker unreachable for ${what}`, error);
    throw unavailable();
  }
  const body = (await response.json().catch(() => null)) as {
    value?: T;
    error?: {
      status: number;
      message: string;
      code?: ErrorCode;
      details?: unknown;
    };
  } | null;
  if (response.ok && body && "value" in body) return body.value as T;
  if (body?.error && body.error.status === response.status)
    throw new DataError(
      body.error.status,
      body.error.message,
      body.error.code,
      body.error.details,
    );
  console.error(`Edge Worker answered ${response.status} to ${what}`);
  throw unavailable();
}

/** Erases a deleted account's site database. */
export async function eraseSiteData(site: string) {
  await callSiteObject(site, "erase", {});
}
