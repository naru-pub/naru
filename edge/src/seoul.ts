import worker, { type Env } from "./index";
import { httpBucket, type HttpBucketEnv } from "./http-bucket";
import { s3Bucket, type S3Env } from "./r2-s3";
import { serveSdk, type SdkEnv } from "./sdk";
import { SiteData as EdgeSiteData } from "./site";
import { dataApi, type WebsiteEnv } from "./website";
import { parseShards, SERVED, shardOf, siteOfPath } from "./shards";

// The edge Worker as it runs on the mini, under workerd (seoul/): the Data
// SDK at sdk.naru.pub (its script, sdk.ts; the data API and live connections,
// website.ts), which only this serves, and the control plane's site
// operations on 127.0.0.1 (index.ts). Hosted pages, their pageviews
// and custom domains stay on Cloudflare (index.ts), so this answers nothing
// else. There is no R2 binding here: the site bucket, where site functions'
// sources are, is reached through R2's S3 API (r2-s3.ts), or, given
// SITE_BUCKET_URL, a local folder naru-dev serves (http-bucket.ts).

type SeoulEnv = Env &
  S3Env &
  SdkEnv &
  WebsiteEnv &
  Partial<HttpBucketEnv> & {
    /**
     * This process's shard, when the mini runs several behind the router
     * (router.ts, shards.ts), with the router's NARU_SDK_SHARD_ORIGINS and
     * NARU_SDK_SHARD_OVERRIDES: a site's request that reaches the wrong one
     * is refused rather than given an empty database. Unset, one process
     * holds every site.
     */
    NARU_SDK_SHARD?: string;
    NARU_SDK_SHARD_ORIGINS?: string;
    NARU_SDK_SHARD_OVERRIDES?: string;
  };

const withBucket = (env: SeoulEnv): SeoulEnv => ({
  ...env,
  SITE_FILES: (env.SITE_BUCKET_URL
    ? httpBucket(env as HttpBucketEnv)
    : s3Bucket(env)) as unknown as R2Bucket,
});

export class SiteData extends EdgeSiteData {
  constructor(ctx: DurableObjectState, env: SeoulEnv) {
    // SiteData is typed by the Cloudflare deployment's generated Env; the
    // bindings it reads are the same here.
    super(ctx, withBucket(env) as never);
  }
}

/** Why this shard is not the site's, or null when it is (or unsharded). */
function misdirected(pathname: string, env: SeoulEnv): string | null {
  if (!env.NARU_SDK_SHARD) return null;
  const site = siteOfPath(pathname);
  if (site === null) return null;
  const shards = parseShards(
    env.NARU_SDK_SHARD_ORIGINS,
    env.NARU_SDK_SHARD_OVERRIDES,
  );
  const own = shardOf(site, shards.origins.length, shards.overrides);
  return String(own) === env.NARU_SDK_SHARD
    ? null
    : `${site} is held by shard ${own}, not ${env.NARU_SDK_SHARD}.`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    // What the health check on Cloudflare probes (standby.ts): workerd answers
    // and a site object's database opens on this disk.
    if (url.pathname === "/healthz/deep") {
      const outcome = await env.SITES.get(
        env.SITES.idFromName("_health"),
      ).ping();
      return outcome.ok
        ? new Response("ok")
        : new Response("unhealthy", { status: 503 });
    }
    if (!SERVED.test(url.pathname))
      return new Response("Not found.", { status: 404 });
    const elsewhere = misdirected(url.pathname, env);
    if (elsewhere) return new Response(elsewhere, { status: 421 });
    // Everything here is the platform's, however it was reached: Caddy sends
    // sdk.naru.pub, and naru's containers call host.docker.internal. The
    // shared router (index.ts) would take any other host for a hosted site.
    url.hostname = `sdk.${env.PLATFORM_DOMAIN}`;
    const platform = new Request(url, request) as Request<
      unknown,
      IncomingRequestCfProperties
    >;
    if (url.pathname.startsWith("/sdk/")) return serveSdk(platform, env);
    return (
      dataApi(platform, withBucket(env), ctx) ??
      worker.fetch!(platform, withBucket(env), ctx)
    );
  },
} satisfies ExportedHandler<SeoulEnv>;
