import worker, { platformHost, type Env } from "./index";
import { dataApi, type WebsiteEnv } from "./website";

// The Worker as `wrangler dev --env local` runs it (wrangler.jsonc): the
// deployed one, plus the SiteData class and the public data API
// (website.ts), so that site databases live in it, as they do on the mini
// (seoul.ts). The deployed Worker has neither. No Data SDK files here: only
// the mini serves them.
export { PageviewLog, Standby } from "./index";
export { SiteData } from "./site";

export default {
  async fetch(request, env, ctx) {
    const { hostname } = new URL(request.url);
    // A hosted site's own /api/data/v1/ path is its file, as on Cloudflare.
    const data = platformHost(hostname, env) && dataApi(request, env, ctx);
    return data || worker.fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Env & WebsiteEnv>;
