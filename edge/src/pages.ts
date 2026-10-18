import { LOGIN_NAME_REGEX } from "../../control-plane/src/lib/const";
import {
  edgeFileCacheUrl,
  edgeSiteCacheTag,
  encodedObjectPath,
} from "../../control-plane/src/lib/edge/file-cache";
import type { PageviewEvent } from "./pageview-log";
import {
  NO_ROUTES,
  routeAnswer,
  routed,
  withHead,
  type RouteAnswer,
  type RouteRules,
} from "../../control-plane/src/lib/site-functions/routes";
import { routesKey } from "../../control-plane/src/lib/site-functions/revisions";
import { DataError } from "../../control-plane/src/lib/site-data/validation";
import { ROUTES_OFF, STATEMENT_PAUSED } from "./types";

// Hosted sites, <login>.naru.pub or a custom domain (domains.ts), answered at
// the edge from the site bucket, so they stay up while the control plane is
// down. The rules are those the retired Rust proxy followed:
//
// - a path names a file under the site's prefix, `<login>/`; one without an
//   extension, or ending in `/`, names that directory's index.html;
// - HTML, JS and JSON are served from the bucket; anything else redirects to
//   the bucket's public domain;
// - an existing directory requested without its trailing slash redirects to
//   it, keeping the query;
// - a top-level navigation to an HTML page records a pageview.
//
// Unlike the proxy, the edge keeps what it reads from the bucket, a file or
// its absence, in each data center's cache for SITE_FILE_CACHE_SECONDS, so a
// busy page is not one bucket read per request. The control plane purges a
// file's entry whenever it changes the file (control-plane/src/lib/
// cache-purge.ts), so edits still appear at once.

export interface PagesEnv {
  /** The site bucket: each site's files under `<login>/`. */
  SITE_FILES: R2Bucket;
  PLATFORM_DOMAIN: string;
  R2_PUBLIC_DOMAIN: string;
  /** How long a data center keeps a lookup; unset or 0 keeps none. */
  SITE_FILE_CACHE_SECONDS?: string;
}

/**
 * Records a navigation without holding the response: the caller keeps the
 * Worker alive until it lands (ExecutionContext.waitUntil).
 */
export type RecordPageview = (event: PageviewEvent) => void;

// Browsers revalidate pages on every request, so edits appear at once and
// every pageview is counted, and may be served stale for a day if the edge
// errs.
const SITE_CACHE_CONTROL = "public, max-age=0, stale-if-error=86400";
// A file's redirect to the bucket's public domain depends on nothing but its
// path, and leads to the file as it is now, so browsers may keep it a week.
const FILE_REDIRECT_CACHE_CONTROL =
  "public, max-age=604800, stale-if-error=86400";
// A directory's redirect to its trailing slash lasts while the directory does,
// so browsers keep it an hour.
const REDIRECT_CACHE_CONTROL = "public, max-age=3600, stale-if-error=86400";
const SERVED = ["html", "htm", "js", "mjs", "json"];
const MAX_METADATA_BYTES = 2048;
// Larger files are read from the bucket each time: the cached copy is written
// while the response streams, and both halves of the body are held until the
// slower has read them.
const MAX_CACHED_BYTES = 5 * 1024 * 1024;

/**
 * The site a subdomain names, or null when it cannot name one. Reserved login
 * names count: the list only keeps them from being registered, and one of
 * them is the operator's own site. A name nobody holds has no files, so it is
 * not found like any missing page.
 */
export function siteOf(host: string, env: PagesEnv) {
  const name = host.replace(/\.$/, "").toLowerCase();
  const suffix = `.${env.PLATFORM_DOMAIN}`;
  if (!name.endsWith(suffix) || name === env.R2_PUBLIC_DOMAIN) return null;
  const login = name.slice(0, -suffix.length);
  return LOGIN_NAME_REGEX.test(login) ? login : null;
}

/**
 * Percent-decodes a URL path as the proxy did: `%XX` becomes that byte, any
 * other `%` stays, and a path that is not UTF-8 afterwards decodes to "".
 */
export function decodePath(path: string) {
  const bytes: number[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const hex = path.slice(index + 1, index + 3);
    if (path[index] === "%" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(...new TextEncoder().encode(path[index]));
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      new Uint8Array(bytes),
    );
  } catch {
    return "";
  }
}

/** A decoded path, without its leading slash, to the file it names. */
export function resolvePath(path: string) {
  const last = path.split("/").at(-1) ?? path;
  const extension =
    last.includes(".") && !last.startsWith(".") && !last.endsWith(".");
  if (path === "" || path === "index.html") return "index.html";
  if (path.endsWith("/")) return `${path}index.html`;
  if (!extension) return `${path}/index.html`;
  return path;
}

/**
 * Where a directory requested without its trailing slash redirects: the
 * request's own path and query, so reserved characters keep their meaning.
 */
export function directoryRedirect(url: URL, decoded: string) {
  if (url.pathname.endsWith("/") || resolvePath(decoded) === decoded)
    return null;
  const path = url.pathname.replace(/^\/+/, "").replaceAll("\\", "%5C");
  // URL drops an empty query; the proxy kept the `?`.
  const query = url.search || (url.href.endsWith("?") ? "?" : "");
  return `/${path}/${query}`;
}

export type RequestKind = "navigation" | "frame" | "background" | "unknown";

/** Navigation intent from Fetch Metadata, as docs/design/pageview-analytics.md. */
export function classify(request: Request): RequestKind {
  if (request.method !== "GET") return "background";
  const mode = request.headers.get("sec-fetch-mode");
  const dest = request.headers.get("sec-fetch-dest");
  if (mode === "navigate" && dest === "document") return "navigation";
  if (mode === "navigate" && (dest === "iframe" || dest === "frame"))
    return "frame";
  if (mode === null || dest === null) return "unknown";
  return "background";
}

/** At most MAX_METADATA_BYTES of UTF-8, cut on a character boundary. */
export function truncate(value: string | null) {
  if (value === null) return null;
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= MAX_METADATA_BYTES) return value;
  let end = MAX_METADATA_BYTES;
  // Continuation bytes are 10xxxxxx; back up to the start of a character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** The path a pageview is counted under: no index.html, no trailing slash. */
export function pageviewPath(decoded: string) {
  if (decoded === "") return "/";
  let path = decoded;
  while (path.endsWith("index.html")) path = path.slice(0, -10);
  path = path.replace(/\/+$/, "");
  return `/${path}`;
}

// Bytes, not strings: a string body would gain a text/plain type the proxy
// never sent.
const text = (body: string) => new TextEncoder().encode(body);

export function notFound() {
  return new Response(text("Not Found"), {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

/** A site operators suspended (domains.ts): gone, as long as it lasts. */
export function suspended() {
  return new Response(
    "이 사이트는 나루 운영 정책에 따라 서비스가 중지되었습니다.\n" +
      "This site has been suspended by Naru.\n",
    {
      status: 410,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

// A 5xx, never a 404, for failures on our side, as the proxy answered.
function unavailable() {
  return new Response(text("Service Unavailable"), {
    status: 502,
    headers: { "Cache-Control": "no-store", "Retry-After": "30" },
  });
}

/** A file read from the bucket or the cache. */
type SiteFile = { body: ReadableStream | null; contentType: string };

/**
 * The bucket object `key`, or null when there is none: from this data
 * center's cache when it holds the lookup, else from the bucket, keeping what
 * it finds for the next request.
 */
async function readFile(
  env: PagesEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  login: string,
  key: string,
): Promise<SiteFile | null> {
  const seconds = Number(env.SITE_FILE_CACHE_SECONDS) || 0;
  const cache =
    seconds > 0
      ? (globalThis as { caches?: { default: Cache } }).caches?.default
      : undefined;
  if (!cache) {
    const object = await env.SITE_FILES.get(key);
    return object && fileOf(object.body, object);
  }
  const url = edgeFileCacheUrl(env.PLATFORM_DOMAIN, key);
  const hit = await cache.match(url);
  if (hit)
    return hit.status === 404
      ? null
      : { body: hit.body, contentType: hit.headers.get("Content-Type") ?? "" };

  const object = await env.SITE_FILES.get(key);
  const headers = {
    "Cache-Control": `public, max-age=${seconds}`,
    "Cache-Tag": edgeSiteCacheTag(login),
  };
  // Caching is best effort: a page is never refused over it.
  const store = (response: Response) =>
    ctx.waitUntil(
      cache
        .put(url, response)
        .catch((error) => console.error(`Caching ${key} failed`, error)),
    );
  if (!object) {
    store(new Response(null, { status: 404, headers }));
    return null;
  }
  if (object.size > MAX_CACHED_BYTES) return fileOf(object.body, object);
  const [served, stored] = object.body.tee();
  const file = fileOf(served, object);
  store(
    new Response(stored, {
      headers: { ...headers, "Content-Type": file.contentType },
    }),
  );
  return file;
}

function fileOf(body: ReadableStream, object: R2Object): SiteFile {
  return { body, contentType: object.httpMetadata?.contentType ?? "" };
}

/**
 * Renders a route in the site's object (wherever it lives: index.ts), as
 * `render` answers: what the route returned, or why it could not.
 */
export type RenderRoute = (input: {
  site: string;
  path: string;
  /** The page's own origin, such as https://alice.naru.pub, for absolute links. */
  origin?: string;
  query: Record<string, string>;
  clientIp?: string;
}) => Promise<
  | { ok: true; value: { result: unknown } }
  | {
      ok: false;
      error: {
        status: number;
        message: string;
        details?: unknown;
        /** Seconds until a limit that refused the render resets. */
        retryAfter?: number;
      };
    }
>;

/**
 * Whether the site's object refused the render because the site is not
 * served now (lapsed or unconfirmed paid status): its own answer, never what
 * Caddy or a failed connection gives while the mini is away.
 */
const routesOff = (error: { status: number; details?: unknown }) =>
  error.status === 404 &&
  (error.details as { reason?: unknown } | null | undefined)?.reason ===
    ROUTES_OFF;

/** Each site's route rules, as its active release has them, kept a little while. */
const ROUTES_SECONDS = 30;
const knownRoutes = new Map<string, { until: number; routes: RouteRules }>();
async function siteRoutes(env: PagesEnv, login: string) {
  const known = knownRoutes.get(login);
  if (known && known.until > Date.now()) return known.routes;
  let routes = NO_ROUTES;
  try {
    const object = await env.SITE_FILES.get(routesKey(login));
    const stored = object ? ((await object.json()) as Partial<RouteRules>) : {};
    const strings = (list: unknown) =>
      Array.isArray(list)
        ? list.filter((rule): rule is string => typeof rule === "string")
        : [];
    routes = {
      include: strings(stored.include),
      exclude: strings(stored.exclude),
    };
  } catch (error) {
    // A site whose routes cannot be read is served as files.
    console.error(`Reading ${login}'s routes failed`, error);
  }
  knownRoutes.set(login, { until: Date.now() + ROUTES_SECONDS * 1000, routes });
  if (knownRoutes.size > 10_000)
    knownRoutes.delete(knownRoutes.keys().next().value!);
  return routes;
}

const escape = (value: string) =>
  value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const routeError = (status: number, message: string, retryAfter?: number) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${status}</title><p>${escape(message)}</p>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
      },
    },
  );

/**
 * A page one of the site's routes answers (routes.ts), or null when no route
 * matches or the site's object cannot be reached, so the site's files answer
 * instead. A route's page is kept in this data center's cache for the
 * seconds it asked for.
 */
async function serveRoute(
  request: Request,
  env: PagesEnv,
  login: string,
  ctx: Pick<ExecutionContext, "waitUntil">,
  render: RenderRoute,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!routed(await siteRoutes(env, login), url.pathname)) return null;
  const cache = (globalThis as { caches?: { default: Cache } }).caches?.default;
  const key = new Request(url.toString());
  const hit = await cache?.match(key);
  if (hit) {
    const response = new Response(hit.body, hit);
    response.headers.set("Cache-Control", SITE_CACHE_CONTROL);
    return response;
  }
  let outcome: Awaited<ReturnType<RenderRoute>>;
  try {
    outcome = await render({
      site: login,
      path: url.pathname,
      // The address the visitor asked: a subdomain or a custom domain.
      origin: url.origin,
      query: Object.fromEntries(url.searchParams),
      clientIp: request.headers.get("cf-connecting-ip") ?? undefined,
    });
  } catch (error) {
    console.error(`Rendering ${login}'s ${url.pathname} failed`, error);
    return away(request, env, ctx, login);
  }
  if (!outcome.ok) {
    // A site whose paid status has lapsed: its route paths are not found, as
    // any unknown path is, not the page served while the mini is away.
    if (routesOff(outcome.error)) return notFound();
    // A statement of the route the runtime stopped too often is paused
    // (breaker.ts): the mini is there, and says so.
    const paused =
      (outcome.error.details as { reason?: unknown } | null | undefined)
        ?.reason === STATEMENT_PAUSED;
    return outcome.error.status === 503 && !paused
      ? away(request, env, ctx, login)
      : routeError(
          outcome.error.status,
          outcome.error.message,
          outcome.error.retryAfter,
        );
  }
  let answer: RouteAnswer;
  try {
    answer = routeAnswer(outcome.value.result);
  } catch (error) {
    return routeError(
      500,
      error instanceof DataError ? error.message : "The route failed.",
    );
  }
  let response: Response;
  if ("redirect" in answer)
    response = new Response(null, {
      status: answer.status,
      headers: { Location: answer.redirect },
    });
  else if ("html" in answer)
    response = new Response(answer.html, {
      status: answer.status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  else if ("body" in answer)
    response = new Response(answer.body, {
      status: answer.status,
      headers: {
        "Content-Type": `${answer.type}; charset=utf-8`,
        // A feed is not a page the site's scripts run in.
        "X-Content-Type-Options": "nosniff",
      },
    });
  else {
    const path = resolvePath(answer.file);
    const file = await readFile(env, ctx, login, `${login}/${path}`);
    if (!file)
      return routeError(404, `The route's file ${answer.file} is not there.`);
    const html = /\.html?$/.test(path);
    response = new Response(
      html
        ? withHead(await new Response(file.body).text(), answer.head)
        : file.body,
      {
        status: answer.status,
        headers: {
          "Content-Type": file.contentType || "text/html; charset=utf-8",
        },
      },
    );
  }
  if (answer.cache > 0 && cache && answer.status < 400) {
    const stored = response.clone();
    stored.headers.set("Cache-Control", `public, max-age=${answer.cache}`);
    stored.headers.set("Cache-Tag", edgeSiteCacheTag(login));
    ctx.waitUntil(
      cache
        .put(key, stored)
        .catch((error) => console.error(`Caching ${url} failed`, error)),
    );
  }
  response.headers.set(
    "Cache-Control",
    answer.cache > 0 ? SITE_CACHE_CONTROL : "no-store",
  );
  return response;
}

/**
 * A route that could not be rendered because the mini, where site databases
 * live, is away: unreachable, or answering 502/503/504. A page's navigation gets the site's
 * own index.html, at 503, so an app's shell still loads and can say so;
 * anything else, or a site without index.html, is answered as if there were
 * no routes (null).
 */
async function away(
  request: Request,
  env: PagesEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  login: string,
): Promise<Response | null> {
  const kind = classify(request);
  if (kind !== "navigation" && kind !== "frame") return null;
  let file: SiteFile | null;
  try {
    file = await readFile(env, ctx, login, `${login}/index.html`);
  } catch (error) {
    console.error(`Reading ${login}/index.html failed`, error);
    return null;
  }
  if (!file) return null;
  return new Response(file.body, {
    status: 503,
    headers: {
      "Content-Type": file.contentType || "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "60",
    },
  });
}

/** Answers a request for one of the sites `siteOf` names. */
export async function servePage(
  request: Request,
  env: PagesEnv,
  login: string,
  ctx: Pick<ExecutionContext, "waitUntil">,
  record: RecordPageview,
  render?: RenderRoute,
): Promise<Response> {
  const kind = classify(request);
  const timestamp = Date.now();
  const url = new URL(request.url);
  if (render && (request.method === "GET" || request.method === "HEAD")) {
    const routed = await serveRoute(request, env, login, ctx, render);
    if (routed) {
      if (kind === "navigation" && routed.status === 200)
        record({
          login,
          timestamp,
          path: pageviewPath(decodePath(url.pathname.replace(/^\/+/, ""))),
          ip: request.headers.get("cf-connecting-ip") ?? "",
          referrer: truncate(request.headers.get("referer")),
          userAgent: truncate(request.headers.get("user-agent")),
        });
      return routed;
    }
  }
  const decoded = decodePath(url.pathname.replace(/^\/+/, ""));
  const path = resolvePath(decoded);
  const extension = path.split(".").at(-1) ?? "";
  if (!SERVED.includes(extension))
    return new Response(text("Redirecting..."), {
      status: 302,
      headers: {
        // Encoded as the control plane purges it.
        Location: `https://${env.R2_PUBLIC_DOMAIN}/${encodedObjectPath(`${login}/${path}`)}`,
        "Cache-Control": FILE_REDIRECT_CACHE_CONTROL,
      },
    });

  let file: SiteFile | null;
  try {
    file = await readFile(env, ctx, login, `${login}/${path}`);
  } catch (error) {
    console.error(`Reading ${login}/${path} failed`, error);
    return unavailable();
  }
  if (!file) return notFound();
  // Only an existing directory is canonicalized. The redirect is not a
  // pageview; the request it leads to records one.
  const location = directoryRedirect(url, decoded);
  if (location) {
    await file.body?.cancel();
    return new Response(null, {
      status: 308,
      headers: { Location: location, "Cache-Control": REDIRECT_CACHE_CONTROL },
    });
  }
  if ((extension === "html" || extension === "htm") && kind === "navigation")
    record({
      login,
      timestamp,
      path: pageviewPath(decoded),
      ip: request.headers.get("cf-connecting-ip") ?? "",
      referrer: truncate(request.headers.get("referer")),
      userAgent: truncate(request.headers.get("user-agent")),
    });
  return new Response(file.body, {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": SITE_CACHE_CONTROL,
    },
  });
}
