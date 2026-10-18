// The parts as the package ships them, beside its bundles in dist/
// (scripts/build.mjs): the Worker in worker/, the SDK in sdk/, what it was
// built from in build.json, and workerd from the workerd package.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Info } from "./cli";
import type { Resources } from "./naru";

const here = dirname(fileURLToPath(import.meta.url));

export function packagedResources(): Resources {
  const require = createRequire(import.meta.url);
  const workerd = require("workerd") as { default: string };
  return {
    workerDir: join(here, "worker"),
    sdkDir: join(here, "sdk"),
    workerd: workerd.default,
  };
}

export const packagedInfo = (): Info =>
  JSON.parse(readFileSync(join(here, "build.json"), "utf8"));
