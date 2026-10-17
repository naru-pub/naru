import worker, { type Env } from "./index";
import { s3Bucket, type S3Env } from "./r2-s3";
import { serveSdk, type SdkEnv } from "./sdk";
import { SiteData as EdgeSiteData } from "./site";
import { dataApi, type WebsiteEnv } from "./website";

// The edge Worker as it runs on the mini, under workerd (seoul/): the Data
// SDK at sdk.naru.pub (its script, sdk.ts; the data API and live connections,
// website.ts), which only this serves, and the control plane's site
// operations on 127.0.0.1 (index.ts). Hosted pages, their pageviews
// and custom domains stay on Cloudflare (index.ts), so this answers nothing
// else. There is no R2 binding here: the site bucket, where site functions'
// sources are, is reached through R2's S3 API (r2-s3.ts).

type SeoulEnv = Env & S3Env & SdkEnv & WebsiteEnv;

const withBucket = (env: SeoulEnv): SeoulEnv => ({
  ...env,
  SITE_FILES: s3Bucket(env) as unknown as R2Bucket,
});

export class SiteData extends EdgeSiteData {
  constructor(ctx: DurableObjectState, env: SeoulEnv) {
    // SiteData is typed by the Cloudflare deployment's generated Env; the
    // bindings it reads are the same here.
    super(ctx, withBucket(env) as never);
  }
}

const SERVED = /^\/(?:sdk\/|api\/data\/v1\/|v1\/sites\/|v1\/breakers\/)/;

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
