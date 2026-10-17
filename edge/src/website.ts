import { parseFilterQuery } from "../../control-plane/src/lib/site-data/filters";
import {
  CALLS,
  PUBLIC_READ_CACHE,
  publicResult,
  websiteCondition,
  websiteHeaders,
} from "../../control-plane/src/lib/site-data/protocol";
import {
  DataError,
  functionReference,
  jsonBody,
  NAME,
  protocolError,
  refusalResponse,
  secondsUntil,
  withRetryAfter,
} from "../../control-plane/src/lib/site-data/validation";
import type { SiteData } from "./site";
import { interruptedCall } from "./sql";
import { admit, breakers, settle, type CallIdentity } from "./breaker";
import {
  OWNER_TICKET,
  verifyLiveTicket,
} from "../../control-plane/src/lib/site-data/live-ticket";
import type { Outcome, Served } from "./types";

// The public data API, sdk.naru.pub/api/data/v1/<site>/..., answered by
// workerd on the mini (seoul.ts) and in local runs (local.ts), where site
// databases live; the Worker on Cloudflare has none and never routes here.
// A visitor's request is answered from the site's object instead of going on
// to the control plane. Whatever needs the control plane
// is sent on to it unchanged: requests with an owner token (sign-in scope and
// renewal live in PostgreSQL), media (`_files`), batches (owner only),
// members' queries and mutations, and any request the object will not
// answer, such as a site whose paid status it has not had confirmed.
//
// The answer is the control plane's (http.ts), from the same protocol module:
// same headers, same caching, same errors.

export interface WebsiteEnv {
  SITES: DurableObjectNamespace<SiteData>;
  /** Shared with the control plane, which signs members' live tickets. */
  EDGE_WORKER_SECRET?: string;
  /**
   * Where requests are sent on, instead of the request's own URL: the control
   * plane beside workerd on the mini (seoul.ts), and in tests.
   */
  PASSTHROUGH_ORIGIN?: string;
  /**
   * "off" where there is no edge cache (workerd on the mini): visitors' reads
   * are then answered by the object each time, which is local there.
   */
  EDGE_CACHE?: string;
  /**
   * The runtime's step budget for one SQLite statement, in ms, where it has
   * one (workerd on the mini: seoul/workerd/), for saying so when it stops one.
   */
  SQLITE_STATEMENT_TIMEOUT_MS?: string;
}

const METHODS = ["GET", "POST", "PUT", "DELETE"];

// Sites whose monthly budget is spent, until it resets, so that refusing them
// costs this isolate a map lookup rather than the object a request.
const spent = new Map<string, { until: number; message: string }>();

/**
 * Opens a live connection for live queries: a visitor's, or with a member's
 * `ticket`, that member's, whose queries run as them. Refusals are plain
 * HTTP, before any WebSocket opens.
 */
async function live(request: Request, env: WebsiteEnv, site: string) {
  const url = new URL(request.url);
  if (!NAME.test(site)) return new Response("Not found.", { status: 404 });
  const ticket = url.searchParams.get("ticket");
  let member: string | null = null;
  if (ticket !== null) {
    member = env.EDGE_WORKER_SECRET
      ? await verifyLiveTicket(env.EDGE_WORKER_SECRET, site, ticket)
      : null;
    if (!member)
      return new Response("The live ticket is invalid or expired.", {
        status: 401,
      });
  }
  const stub = env.SITES.get(env.SITES.idFromName(site));
  return stub.fetch(
    new Request("https://site.invalid/_live", {
      headers: {
        Upgrade: "websocket",
        // For the connection's live queries: whose site, and whose address
        // a visitor's are limited by.
        "X-Naru-Site": site,
        "X-Naru-Client-Ip": request.headers.get("cf-connecting-ip") ?? "",
        // Its statements the runtime stopped too often (breaker.ts).
        "X-Naru-Paused": JSON.stringify(breakers.paused(site, Date.now())),
        ...(member === OWNER_TICKET
          ? { "X-Naru-Owner": "1" }
          : member
            ? { "X-Naru-Member": member }
            : {}),
      },
    }),
  );
}

/**
 * Runs a visitor's query or mutation in the site's object. What the object
 * will not answer, such as a site whose paid status it has not had
 * confirmed, goes on to the control plane.
 */
async function visit(
  request: Request,
  env: WebsiteEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  site: string,
  path: string[],
  headers: Record<string, string>,
) {
  const original = request.clone();
  try {
    const { file, fn } = functionReference(path.slice(1).join("/"));
    const body = await jsonBody(request);
    const kind = CALLS[path[0]];
    const call: CallIdentity = { kind, file, name: fn };
    // Refused here when the whole function is paused (breaker.ts).
    const { paused, refusal } = admit(site, call);
    if (refusal) return refusalResponse(refusal, headers);
    const stub = env.SITES.get(env.SITES.idFromName(site));
    let outcome: Outcome<
      { pass: true } | { pass?: undefined; result: unknown }
    >;
    try {
      outcome = (await stub.visit({
        site,
        kind,
        file,
        name: fn,
        args: body?.args ?? null,
        clientIp: request.headers.get("cf-connecting-ip") ?? undefined,
        paused,
      })) as typeof outcome;
    } catch (error) {
      settle(env.SITES, ctx, site, call, error);
      throw error;
    }
    settle(env.SITES, ctx, site, call);
    if (!outcome.ok) return refusalResponse(outcome.error, headers);
    if (outcome.value.pass) return passThrough(original, env);
    return Response.json({ result: outcome.value.result }, { headers });
  } catch (error) {
    if (error instanceof DataError) return refusalResponse(error, headers);
    // A write of the site's code the runtime stopped, which reset the object.
    const stopped = interruptedCall(error, env, "site");
    if (stopped) return refusalResponse(stopped, headers);
    console.error("A visitor's call failed", error);
    return protocolError(500, "Function call failed.", undefined, headers);
  }
}

/** Sends the request to the control plane, the origin behind this route. */
function passThrough(request: Request, env: WebsiteEnv) {
  if (!env.PASSTHROUGH_ORIGIN) return fetch(request);
  const url = new URL(request.url);
  return fetch(
    new Request(
      new URL(url.pathname + url.search, env.PASSTHROUGH_ORIGIN),
      request,
    ),
  );
}

const ROUTE = /^\/api\/data\/v1\/([^/]+)(?:\/(.*))?$/;

/** A data API request's answer, or null for any other path. */
export function dataApi(
  request: Request,
  env: WebsiteEnv,
  ctx: ExecutionContext,
): Promise<Response> | null {
  const route = ROUTE.exec(new URL(request.url).pathname);
  if (!route) return null;
  return website(
    request,
    env,
    ctx,
    decodeURIComponent(route[1]),
    (route[2] ?? "")
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part)),
  );
}

export async function website(
  request: Request,
  env: WebsiteEnv,
  ctx: ExecutionContext,
  site: string,
  path: string[],
): Promise<Response> {
  const headers = websiteHeaders(request);
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  // A live connection: opened here, held by the site's object. Asking for a
  // member's ticket (POST, with their token) goes to the control plane below.
  if (
    path[0] === "_live" &&
    path.length === 1 &&
    request.headers.get("Upgrade")?.toLowerCase() === "websocket"
  )
    return live(request, env, site);
  // A visitor's query or mutation: answered here, like a visitor's read.
  if (
    Object.hasOwn(CALLS, path[0]) &&
    request.method === "POST" &&
    !request.headers.has("authorization") &&
    NAME.test(site)
  )
    return visit(request, env, ctx, site, path, headers);
  if (
    !NAME.test(site) ||
    request.headers.has("authorization") ||
    !path.length ||
    path[0] === "_files" ||
    path[0] === "_batch" ||
    Object.hasOwn(CALLS, path[0]) ||
    !METHODS.includes(request.method)
  )
    return passThrough(request, env);
  const refusal = spent.get(site);
  if (refusal && Date.now() < refusal.until)
    return protocolError(
      429,
      refusal.message,
      "RATE_LIMITED",
      withRetryAfter(headers, secondsUntil(refusal.until)),
    );

  const url = new URL(request.url);
  const fresh = url.searchParams.get("fresh") === "1";
  const cache =
    env.EDGE_CACHE === "off"
      ? null
      : (caches as unknown as { default: Cache }).default;
  if (cache && request.method === "GET" && !fresh) {
    const hit = await cache.match(request);
    if (hit) {
      // Stored with a cacheable lifetime; sent with the public one.
      const response = new Response(hit.body, hit);
      response.headers.set("Cache-Control", PUBLIC_READ_CACHE);
      return response;
    }
  }
  // Kept whole in case the object hands the request back.
  const original = request.method === "GET" ? request : request.clone();
  try {
    const body = ["POST", "PUT"].includes(request.method)
      ? await jsonBody(request)
      : undefined;
    const stub = env.SITES.get(env.SITES.idFromName(site));
    const outcome = (await stub.serve({
      path,
      method: request.method,
      site,
      body,
      filter: parseFilterQuery(url.searchParams.get("filter")),
      includeTotal: url.searchParams.get("includeTotal") === "1",
      ifVersion: websiteCondition(url),
      sort: url.searchParams.get("sort") ?? undefined,
      after: url.searchParams.get("after") ?? undefined,
      size: url.searchParams.has("size")
        ? Number(url.searchParams.get("size"))
        : undefined,
      // Set by Cloudflare at the edge, so it can be trusted here.
      clientIp: request.headers.get("cf-connecting-ip") ?? undefined,
    })) as Outcome<Served>;
    if (!outcome.ok) {
      const { status, message, code, resetsAt, retryAfter } = outcome.error;
      if (resetsAt) spent.set(site, { until: resetsAt, message });
      return protocolError(
        status,
        message,
        code,
        withRetryAfter(headers, retryAfter),
      );
    }
    if (outcome.value.pass) return passThrough(original, env);
    const { result, publicRead } = outcome.value;
    const cacheable = publicRead && !fresh;
    const response = Response.json(publicResult(result), {
      status: request.method === "POST" ? 201 : 200,
      headers: {
        ...headers,
        ...(cacheable ? { "Cache-Control": PUBLIC_READ_CACHE } : {}),
      },
    });
    if (cache && cacheable && request.method === "GET") {
      // The Cache API keeps a response for its max-age, which the public
      // header sets to 0 for browsers; store it with the shared lifetime.
      const stored = response.clone();
      const copy = new Response(stored.body, stored);
      copy.headers.set("Cache-Control", "public, max-age=10");
      ctx.waitUntil(cache.put(request, copy));
    }
    return response;
  } catch (error) {
    if (error instanceof DataError)
      return protocolError(
        error.status,
        error.message,
        error.code,
        withRetryAfter(headers, error.retryAfter),
      );
    // Naru's own write, stopped by the runtime, which reset the object.
    const stopped = interruptedCall(error, env, "naru");
    if (stopped) return refusalResponse(stopped, headers);
    console.error("Site database request failed", error);
    return protocolError(500, "Database request failed.", undefined, headers);
  }
}
