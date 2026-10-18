// A local Naru for one site, from this checkout:
//   pnpm naru-dev <site folder> [--site name] [--port 4000] [--state dir]
//
// The same naru-dev as the @naru-pub/dev package (../../naru-dev, whose
// README says what it emulates), run from source: the edge Worker is bundled
// from ../../edge into naru-dev/.worker/ first, and served with edge's
// workerd and this checkout's SDK files. Install ../edge first (pnpm install
// there).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
// @ts-expect-error: a plain module of the package's build, without types.
import { buildWorker } from "../../naru-dev/scripts/build-worker.mjs";
import { main } from "../../naru-dev/src/cli";

const repo = resolve(import.meta.dirname, "../..");
const edge = join(repo, "edge");
if (!existsSync(join(edge, "node_modules/.bin/wrangler"))) {
  console.error("Run pnpm install in edge/ first.");
  process.exit(1);
}
const workerDir = join(repo, "naru-dev/.worker");
await buildWorker(workerDir);
const workerd = createRequire(join(edge, "package.json"))("workerd") as {
  default: string;
};
const { version } = JSON.parse(
  readFileSync(join(repo, "naru-dev/package.json"), "utf8"),
);
let commit = "checkout";
try {
  commit = `${execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()} checkout`;
} catch {
  /* not a git checkout */
}
process.exitCode = await main(
  process.argv.slice(2),
  {
    workerDir,
    sdkDir: join(repo, "control-plane/public/sdk"),
    workerd: workerd.default,
  },
  { version, commit },
);
