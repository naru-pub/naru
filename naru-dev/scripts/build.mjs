// Builds the package into dist/, from the repository's sources:
//
//   dist/cli.mjs, index.mjs, testing.mjs   src/, with the control plane's
//                                          modules it imports bundled in
//   dist/index.d.ts, testing.d.ts          src/api.d.ts
//   dist/worker/                           the edge Worker and config.capnp
//                                          (build-worker.mjs)
//   dist/sdk/<version>/                    control-plane/public/sdk
//   dist/build.json                        the version and naru-pub commit
//
// and LICENSE, the repository's. Needs this folder's and edge/'s
// dependencies (pnpm install in each).
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorker } from "./build-worker.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..");
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist);

const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
let commit = "unknown";
try {
  commit = git("rev-parse", "--short=12", "HEAD");
  if (git("status", "--porcelain", "--", ".")) commit += "-dirty";
} catch {
  /* not a checkout */
}

await build({
  entryPoints: {
    cli: join(root, "src/bin.ts"),
    index: join(root, "src/index.ts"),
    testing: join(root, "src/testing.ts"),
  },
  outdir: dist,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["workerd"],
  chunkNames: "[name]-[hash]",
  legalComments: "none",
  logLevel: "warning",
});

const types = await readFile(join(root, "src/api.d.ts"), "utf8");
await writeFile(join(dist, "index.d.ts"), types);
await writeFile(join(dist, "testing.d.ts"), 'export * from "./index.js";\n');

await buildWorker(join(dist, "worker"), { maps: false });
await cp(join(repo, "control-plane/public/sdk"), join(dist, "sdk"), {
  recursive: true,
});
await writeFile(
  join(dist, "build.json"),
  `${JSON.stringify({ version, commit }, null, 2)}\n`,
);
await cp(join(repo, "LICENSE"), join(root, "LICENSE"));
console.log(`dist: @naru-pub/dev ${version} (naru-pub ${commit})`);
