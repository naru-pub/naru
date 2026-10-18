// The edge Worker as naru-dev runs it, into `out`: src/seoul.ts, bundled as
// the mini's is (edge/seoul/build.mjs), and its workerd config, config.capnp,
// for one local process. Unlike the mini's, it opens the test operations
// naru-dev publishes `_naru/` with, reads the site bucket from naru-dev
// (SITE_BUCKET_URL, edge/src/http-bucket.ts), lifts the per-address read
// limit (every tab on the machine is one address) and names objects as
// `wrangler dev` did, so data an older naru-dev kept is found. Needs edge/'s
// dependencies (pnpm install there).
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bundleWorker,
  fromEnvironment,
  modulesOf,
  siteDataConfig,
} from "../../edge/seoul/workerd-config.mjs";

export async function buildWorker(out, { maps = true } = {}) {
  await rm(out, { recursive: true, force: true });
  bundleWorker("wrangler.seoul.jsonc", out);
  if (!maps)
    for (const file of await readdir(out))
      if (file.endsWith(".map") || file === "README.md")
        await rm(join(out, file));
  await writeFile(
    join(out, "config.capnp"),
    siteDataConfig({
      header:
        "# Written by naru-dev/scripts/build-worker.mjs; naru-dev serves it\n" +
        "# with --directory-path site-objects=<state>/worker/v3/do and\n" +
        "# sdk-files=<the SDK's files>.",
      modules: await modulesOf(out, "seoul.js", ""),
      bindings: [
        `      (name = "TEST_OPERATIONS", text = "1"),`,
        `      (name = "SITE_READS_PER_MINUTE", text = "100000"),`,
        fromEnvironment("EDGE_WORKER_SECRET"),
        fromEnvironment("PASSTHROUGH_ORIGIN"),
        fromEnvironment("SITE_BUCKET_URL"),
      ],
      sdkFiles: null,
      siteObjects: null,
      uniqueKey: "naru-edge-SiteData",
    }),
  );
}
