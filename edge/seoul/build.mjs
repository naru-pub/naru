// Builds what runs on the mini into seoul/dist/: the Worker (src/seoul.ts)
// and the router in front of it (src/router.ts), as wrangler bundles them,
// the SDK's files, and two workerd configs. What differs per host and per
// process is given when each starts (seoul/README.md):
//
//   workerd serve config.capnp \            each shard, or the one process
//     --directory-path site-objects=<where its site databases live> \
//     --socket-addr http=127.0.0.1:<port>
//   workerd serve router.capnp \            in front of the shards
//     --socket-addr http=127.0.0.1:<port>
//
// with EDGE_WORKER_SECRET, PASSTHROUGH_ORIGIN, the R2_* variables and
// WORKERD_SQLITE_STATEMENT_TIMEOUT_MS in a shard's environment, and
// NARU_SDK_SHARD_ORIGINS, NARU_SDK_SHARD_OVERRIDES (and a shard's own
// NARU_SDK_SHARD) in both. The mini runs Naru's own workerd (seoul/workerd/),
// which holds each statement to that budget.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bundleWorker,
  edge,
  fromEnvironment,
  modulesOf,
  siteDataConfig,
} from "./workerd-config.mjs";

const dist = join(edge, "seoul/dist");
await rm(dist, { recursive: true, force: true });
bundleWorker("wrangler.seoul.jsonc", "seoul/dist/worker");
bundleWorker("wrangler.seoul-router.jsonc", "seoul/dist/router");
await cp(join(edge, "../control-plane/public/sdk"), join(dist, "sdk-files"), {
  recursive: true,
});

const modules = await modulesOf(join(dist, "worker"), "seoul.js", "worker/");
const routerModules = await modulesOf(
  join(dist, "router"),
  "router.js",
  "router/",
);

// Which shard holds each site (src/shards.ts), the router's and each shard's
// alike; unset in a shard, it holds every site.
const sharding = ["NARU_SDK_SHARD_ORIGINS", "NARU_SDK_SHARD_OVERRIDES"].map(
  (name) => fromEnvironment(name),
);

const bindings = [
  "EDGE_WORKER_SECRET",
  "PASSTHROUGH_ORIGIN",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PRIVATE_BUCKET",
].map((name) => fromEnvironment(name));
// The step budget Naru's workerd holds each SQLite statement to
// (seoul/workerd/), so the object can say how long a stopped one ran.
bindings.push(
  fromEnvironment(
    "SQLITE_STATEMENT_TIMEOUT_MS",
    "WORKERD_SQLITE_STATEMENT_TIMEOUT_MS",
  ),
  fromEnvironment("NARU_SDK_SHARD"),
  ...sharding,
);

await writeFile(
  join(dist, "config.capnp"),
  siteDataConfig({
    header:
      "# Written by seoul/build.mjs; see the comment there for how to serve it.",
    modules,
    bindings,
    sdkFiles: "sdk-files",
    siteObjects: "site-objects",
    uniqueKey: "naru-site-data",
  }),
);

await writeFile(
  join(dist, "router.capnp"),
  `# Written by seoul/build.mjs; see the comment there for how to serve it.
# The router (src/router.ts) in front of the shards, each config.capnp.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .router),
    # The SDK's committed files (control-plane/public/sdk), at /sdk/.
    (name = "sdk-files", disk = (path = "sdk-files")),
    # The shards, on loopback (NARU_SDK_SHARD_ORIGINS); nothing else.
    (name = "network", network = (allow = ["local"])),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8787", http = (), service = "main"),
  ],
  # It holds no sites: requests and the bodies it reads to retry them.
  v8Flags = ["--max-old-space-size=512"],
);

const router :Workerd.Worker = (
  compatibilityDate = "2026-10-01",
  modules = [
${routerModules.join("\n")}
  ],
  bindings = [
    (name = "SDK_FILES", service = "sdk-files"),
${sharding.join("\n")}
  ],
  globalOutbound = "network",
);
`,
);
await mkdir(join(dist, "site-objects"), { recursive: true });
console.log(
  `seoul/dist: ${modules.length} modules, config.capnp; ${routerModules.length} modules, router.capnp`,
);
