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
} from "../../control-plane/src/lib/site-data/validation";
import type { SiteData } from "./site";
import { verifyLiveTicket } from "../../control-plane/src/lib/site-data/live-ticket";
import type { Outcome, Served } from "./types";

// The public data API, /api/data/v1/<site>/..., routed here for every site.
// A visitor's request is answered at the edge from the site's object instead
// of crossing to the control plane and back. Whatever needs the control plane
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
   * Sites whose databases have moved to the mini, comma-separated, or "*"
   * for all: their requests here go on to the control plane (`website`).
   */
  MOVED_SITES?: string;
  /**
   * "1" while this is the standby, serving with the mini away (standby.ts):
   * visitors read this copy, and nothing that would write or needs the
   * control plane is accepted.
   */
  READ_ONLY?: string;
}

/** Refused while serving as the standby: it needs the mini. */
const unavailable = (headers: Record<string, string>) =>
  protocolError(
    503,
    "Naru's server is away: this site can be read, not changed, until it is back.",
    "UNAVAILABLE",
    headers,
    // The SDK reads public data again without the sign-in, which this copy
    // cannot check, so a signed-in page still shows what visitors may see.
    { standby: true },
  );

/** passThrough, unless this is the standby, which has nowhere to send it. */
const passOn = (
  request: Request,
  env: WebsiteEnv,
  headers: Record<string, string>,
) => (env.READ_ONLY === "1" ? unavailable(headers) : passThrough(request, env));

/** Whether `site`'s database is on the mini: MOVED_SITES lists it, or is "*". */
const moved = (env: WebsiteEnv, site: string) => {
  const sites = (env.MOVED_SITES ?? "").split(",").map((name) => name.trim());
  return sites.includes("*") || sites.includes(site);
};

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
        ...(member ? { "X-Naru-Member": member } : {}),
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
  site: string,
  path: string[],
  headers: Record<string, string>,
) {
  const original = request.clone();
  try {
    const { file, fn } = functionReference(path.slice(1).join("/"));
    const body = await jsonBody(request);
    const stub = env.SITES.get(env.SITES.idFromName(site));
    const outcome = (await stub.visit({
      site,
      kind: CALLS[path[0]],
      file,
      name: fn,
      args: body?.args ?? null,
      clientIp: request.headers.get("cf-connecting-ip") ?? undefined,
      readOnlyOnly: env.READ_ONLY === "1",
    })) as Outcome<{ pass: true } | { pass?: undefined; result: unknown }>;
    if (!outcome.ok) {
      const { status, message, code, details, site } = outcome.error;
      return protocolError(status, message, code, headers, details, site);
    }
    if (outcome.value.pass) return passOn(original, env, headers);
    return Response.json({ result: outcome.value.result }, { headers });
  } catch (error) {
    if (error instanceof DataError)
      return protocolError(
        error.status,
        error.message,
        error.code,
        headers,
        error.details,
        error.site,
      );
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
  // A site whose database has moved to the mini (sdk.naru.pub): this copy is
  // no longer its database. Requests go on to the control plane, which calls
  // the mini, so a page holding an older SDK still works; a live connection
  // would attach to this copy, so it is refused and the SDK retries.
  if (env.READ_ONLY === "1") {
    // A visitor's query reads; a mutation would change the site.
    const visitorCall =
      path[0] === "_query" &&
      request.method === "POST" &&
      !request.headers.has("authorization");
    if (
      request.headers.has("authorization") ||
      request.headers.get("Upgrade")?.toLowerCase() === "websocket" ||
      (request.method !== "GET" && !visitorCall)
    )
      return unavailable(headers);
  } else if (moved(env, site)) {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket")
      return protocolError(
        503,
        "This site's live connections have moved.",
        "UNAVAILABLE",
        headers,
      );
    return passThrough(request, env);
  }
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
    return visit(request, env, site, path, headers);
  if (
    !NAME.test(site) ||
    request.headers.has("authorization") ||
    !path.length ||
    path[0] === "_files" ||
    path[0] === "_batch" ||
    Object.hasOwn(CALLS, path[0]) ||
    !METHODS.includes(request.method)
  )
    return passOn(request, env, headers);
  const refusal = spent.get(site);
  if (refusal && Date.now() < refusal.until)
    return protocolError(429, refusal.message, "RATE_LIMITED", headers);

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
      const { status, message, code, resetsAt } = outcome.error;
      if (resetsAt) spent.set(site, { until: resetsAt, message });
      return protocolError(status, message, code, headers);
    }
    if (outcome.value.pass) return passOn(original, env, headers);
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
      return protocolError(error.status, error.message, error.code, headers);
    console.error("Site database request failed", error);
    return protocolError(500, "Database request failed.", undefined, headers);
  }
}
