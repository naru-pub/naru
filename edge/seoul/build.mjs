// Builds the Worker that runs on the mini (src/seoul.ts) into seoul/dist/: the
// bundle wrangler makes, the SDK's files, and config.capnp, which workerd
// serves. What differs per host is given when it starts (seoul/README.md):
//
//   workerd serve config.capnp \
//     --directory-path site-objects=<where site databases live> \
//     --socket-addr http=127.0.0.1:<port>
//
// with EDGE_WORKER_SECRET, PASSTHROUGH_ORIGIN, the R2_* variables and
// WORKERD_SQLITE_STATEMENT_TIMEOUT_MS in its environment. The mini runs Naru's
// own workerd (seoul/workerd/), which holds each statement to that budget.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const edge = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(edge, "seoul/dist");
await rm(dist, { recursive: true, force: true });
execFileSync(
  join(edge, "node_modules/.bin/wrangler"),
  [
    "deploy",
    "--dry-run",
    "--config",
    "wrangler.seoul.jsonc",
    "--outdir",
    "seoul/dist/worker",
  ],
  { cwd: edge, stdio: "inherit" },
);
await cp(join(edge, "../control-plane/public/sdk"), join(dist, "sdk-files"), {
  recursive: true,
});

const files = (await readdir(join(dist, "worker"))).filter(
  (file) => !file.endsWith(".map") && file !== "README.md",
);
const kind = (file) =>
  file.endsWith(".wasm")
    ? "wasm"
    : file.endsWith(".js") || file.endsWith(".mjs")
      ? "esModule"
      : null;
// The entry first: workerd takes the first module as the Worker's main.
const modules = ["seoul.js", ...files.filter((file) => file !== "seoul.js")]
  .filter((file) => kind(file))
  .map(
    (file) =>
      `      (name = "${file}", ${kind(file)} = embed "worker/${file}"),`,
  );

const fromEnvironment = [
  "EDGE_WORKER_SECRET",
  "PASSTHROUGH_ORIGIN",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
].map((name) => `      (name = "${name}", fromEnvironment = "${name}"),`);
// The step budget Naru's workerd holds each SQLite statement to
// (seoul/workerd/), so the object can say how long a stopped one ran.
fromEnvironment.push(
  `      (name = "SQLITE_STATEMENT_TIMEOUT_MS", fromEnvironment = "WORKERD_SQLITE_STATEMENT_TIMEOUT_MS"),`,
);

await writeFile(
  join(dist, "config.capnp"),
  `# Written by seoul/build.mjs; see the comment there for how to serve it.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    # The SDK's committed files (control-plane/public/sdk), at /sdk/.
    (name = "sdk-files", disk = (path = "sdk-files")),
    # Each site's SQLite database. Override with --directory-path.
    (name = "site-objects", disk = (path = "site-objects", writable = true)),
    # R2 is public; the control plane, for requests with a token, is local.
    (name = "network", network = (allow = ["public", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8787", http = (), service = "main"),
  ],
  # The most V8 keeps for JavaScript objects (MB), in the one isolate every
  # site's object and the Worker share: past it V8 aborts workerd, and
  # launchd starts it again. ArrayBuffers and SQLite are not counted; the
  # mini's watchdog (~/Git/infra, naru-sdk-watchdog) kills workerd past 4 GB
  # in all. See README.md, "Memory".
  v8Flags = ["--max-old-space-size=2048"],
);

const worker :Workerd.Worker = (
  compatibilityDate = "2026-10-01",
  compatibilityFlags = ["nodejs_compat"],
  modules = [
${modules.join("\n")}
  ],
  bindings = [
    (name = "SITES", durableObjectNamespace = "SiteData"),
    (name = "SDK_FILES", service = "sdk-files"),
    (name = "PLATFORM_DOMAIN", text = "naru.pub"),
    (name = "SITE_MONTHLY_REQUESTS", text = "5000000"),
    # No edge cache here: each visitor's read is a local SQLite query.
    (name = "EDGE_CACHE", text = "off"),
${fromEnvironment.join("\n")}
  ],
  durableObjectNamespaces = [
    (className = "SiteData", uniqueKey = "naru-site-data", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "site-objects"),
  globalOutbound = "network",
);
`,
);
await mkdir(join(dist, "site-objects"), { recursive: true });
console.log(`seoul/dist: ${modules.length} modules, config.capnp`);
