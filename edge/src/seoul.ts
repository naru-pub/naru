import worker, { platformHost, type Env } from "./index";
import { s3Bucket, type S3Env } from "./r2-s3";
import { SiteData as EdgeSiteData } from "./site";

// The edge Worker as it runs on the mini, under workerd (seoul/): the Data
// SDK at sdk.naru.pub (its script, the data API and live connections) and the
// control plane's site operations on 127.0.0.1. Hosted pages, their pageviews
// and custom domains stay on Cloudflare (index.ts), so this answers nothing
// else. There is no R2 binding here: the site bucket, where site functions'
// sources are, is reached through R2's S3 API (r2-s3.ts).

type SeoulEnv = Env & S3Env;

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

const SERVED = /^\/(?:sdk\/|api\/data\/v1\/|v1\/sites\/)/;

export default {
  fetch(request, env, ctx) {
    const { hostname, pathname } = new URL(request.url);
    if (pathname === "/healthz") return new Response("ok");
    if (!platformHost(hostname, env) || !SERVED.test(pathname))
      return new Response("Not found.", { status: 404 });
    return worker.fetch!(
      request as Request<unknown, IncomingRequestCfProperties>,
      withBucket(env),
      ctx,
    );
  },
} satisfies ExportedHandler<SeoulEnv>;
