// Builds the package into dist/ from the SDK Naru serves: one SDK version's
// naru.js, naru.d.ts and functions.d.ts from control-plane/public/sdk, copied
// unchanged, so the package is byte for byte what
// https://sdk.naru.pub/sdk/<version>/ serves. And LICENSE, the repository's.
//
// The package's version names the SDK version. While that version is still
// being built (it is in build-sdk.mjs's VERSIONS), the file Naru serves can
// change and a published package cannot, so the package is a prerelease of it
// (1.1.0-dev.N); once it is frozen, the package is that version exactly.
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..");
const dist = join(root, "dist");

const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const [, sdk, prerelease] = /^(\d+\.\d+\.\d+)(-dev\.\d+)?$/.exec(version) ?? [];
if (!sdk) throw new Error(`${version}: expected <sdk version>[-dev.<n>]`);

const buildSdk = await readFile(
  join(repo, "control-plane/scripts/build-sdk.mjs"),
  "utf8",
);
const unfrozen = JSON.parse(
  /^const VERSIONS = (\[[^\]]*\]);$/m.exec(buildSdk)[1],
).includes(sdk);
if (unfrozen && !prerelease)
  throw new Error(
    `SDK ${sdk} is still built from source (build-sdk.mjs VERSIONS); publish it as ${sdk}-dev.<n>.`,
  );
if (!unfrozen && prerelease)
  throw new Error(`SDK ${sdk} is frozen; publish it as ${sdk}.`);

const source = join(repo, "control-plane/public/sdk", sdk);
await rm(dist, { recursive: true, force: true });
await mkdir(dist);
for (const name of ["naru.js", "naru.d.ts", "functions.d.ts"]) {
  // 1.0.0 has no functions.d.ts.
  if (existsSync(join(source, name)))
    await cp(join(source, name), join(dist, name));
  else if (name !== "functions.d.ts")
    throw new Error(`${join(source, name)} is missing`);
}
await cp(join(repo, "LICENSE"), join(root, "LICENSE"));
console.log(`dist: @naru-pub/sdk ${version} (sdk.naru.pub/sdk/${sdk}/)`);
