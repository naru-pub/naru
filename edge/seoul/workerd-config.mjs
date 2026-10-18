// What seoul/build.mjs and naru-dev's build (../naru-dev/scripts/build.mjs)
// share: bundling a Worker as wrangler does, and the workerd config of the
// Worker with site databases in it (src/seoul.ts), which the mini runs as
// each shard and naru-dev runs as its one local process. They differ only in
// their bindings, where the SDK's files and site databases are, and the name
// objects' ids derive from.
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const edge = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Bundles the Worker `config` (a wrangler file in edge/) into `outdir`. */
export const bundleWorker = (config, outdir) =>
  execFileSync(
    join(edge, "node_modules/.bin/wrangler"),
    ["deploy", "--dry-run", "--config", config, "--outdir", outdir],
    { cwd: edge, stdio: "inherit" },
  );

const kind = (file) =>
  file.endsWith(".wasm")
    ? "wasm"
    : file.endsWith(".js") || file.endsWith(".mjs")
      ? "esModule"
      : null;

/**
 * The modules of the bundle in `dir`, as config lines that embed each from
 * `prefix` (the bundle's path from the config). The entry first: workerd
 * takes the first module as the Worker's main.
 */
export async function modulesOf(dir, entry, prefix) {
  const files = (await readdir(dir)).filter(
    (file) => !file.endsWith(".map") && file !== "README.md",
  );
  return [entry, ...files.filter((file) => file !== entry)]
    .filter((file) => kind(file))
    .map(
      (file) =>
        `      (name = "${file}", ${kind(file)} = embed "${prefix}${file}"),`,
    );
}

/** A binding of `name` to the environment variable `variable`. */
export const fromEnvironment = (name, variable = name) =>
  `      (name = "${name}", fromEnvironment = "${variable}"),`;

/**
 * The config of the Worker with site databases in it: `modules` (modulesOf),
 * `bindings` (config lines) after the ones every such Worker has, the SDK's
 * files and the site databases at `sdkFiles` and `siteObjects` (paths, or
 * null to be given with --directory-path), and objects' ids derived from
 * `uniqueKey`.
 */
export function siteDataConfig({
  header,
  modules,
  bindings,
  sdkFiles,
  siteObjects,
  uniqueKey,
}) {
  const disk = (path, writable) =>
    `(${[
      ...(path === null ? [] : [`path = "${path}"`]),
      ...(writable ? ["writable = true"] : []),
    ].join(", ")})`;
  return `${header}
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    # The SDK's committed files (control-plane/public/sdk), at /sdk/.
    (name = "sdk-files", disk = ${disk(sdkFiles, false)}),
    # Each site's SQLite database. Override with --directory-path.
    (name = "site-objects", disk = ${disk(siteObjects, true)}),
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
${bindings.join("\n")}
  ],
  durableObjectNamespaces = [
    (className = "SiteData", uniqueKey = "${uniqueKey}", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "site-objects"),
  globalOutbound = "network",
);
`;
}
