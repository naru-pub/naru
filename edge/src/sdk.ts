import aliases from "../../control-plane/sdk/aliases.json";

// The Data SDK, sdk.naru.pub/sdk/<version>/naru.js, naru.d.ts and (1.1.0)
// functions.d.ts, answered by workerd on the mini (seoul.ts) beside the data
// API. Nothing else serves it: not the Worker on Cloudflare (index.ts), and
// naru.pub/sdk/ is a 404 (control-plane src/proxy.ts).
// The files are the committed control-plane/public/sdk/, copied beside the
// Worker as workerd's sdk-files service (edge/seoul/build.mjs); /sdk/1/ stays on stable 1.0.0 as configured
// in control-plane/sdk/aliases.json.

export interface SdkEnv {
  /** control-plane/public/sdk/, so /1.0.0/naru.js is that release's module. */
  SDK_FILES: Fetcher;
}

const VERSION = /^\d+\.\d+\.\d+$/;
export const SDK_CACHE = "public, max-age=300, stale-while-revalidate=86400";
const CONTENT_TYPES: Record<string, string> = {
  "naru.js": "text/javascript; charset=utf-8",
  // Declarations are text an editor or a person reads: the SDK's, and from
  // 1.1.0 what site functions and collection rules are handed.
  "naru.d.ts": "text/plain; charset=utf-8",
  "functions.d.ts": "text/plain; charset=utf-8",
};

const ALIASES: Record<string, string> = aliases;

/** The asset a /sdk/ path names, such as "/1.0.0/naru.js", or null. */
export function sdkAsset(pathname: string) {
  const match = /^\/sdk\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match || !Object.hasOwn(CONTENT_TYPES, match[2])) return null;
  const version = Object.hasOwn(ALIASES, match[1])
    ? ALIASES[match[1]]
    : match[1];
  return VERSION.test(version) ? `/${version}/${match[2]}` : null;
}

export async function serveSdk(request: Request, env: SdkEnv) {
  const url = new URL(request.url);
  const asset = sdkAsset(url.pathname);
  if (!asset) return new Response("Not found.", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed.", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  // The visitor's own headers, so a revalidation is answered 304.
  const found = await env.SDK_FILES.fetch(
    new Request(new URL(asset, url), {
      method: request.method,
      headers: request.headers,
    }),
  );
  if (!found.ok && found.status !== 304)
    return new Response("Not found.", { status: 404 });
  const response = new Response(found.body, found);
  response.headers.set("Content-Type", CONTENT_TYPES[asset.split("/")[2]]);
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("X-Content-Type-Options", "nosniff");
  // A page loads it from the browser's cache for a day, checking for a newer
  // one in the background once five minutes have passed: no round trip to
  // the edge on a return visit (from Korea that can be Los Angeles), and a
  // fix still reaches every browser within minutes.
  response.headers.set("Cache-Control", SDK_CACHE);
  return response;
}
