// The package as a project gets it: its entry points resolve, the module
// imports in Node and its declaration files are there.
//
//   node test/smoke.mjs     wherever @naru-pub/sdk is installed (CI copies
//                           test/ beside an installed tarball)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const manifest = require.resolve("@naru-pub/sdk/package.json");
const { version, exports } = JSON.parse(await readFile(manifest, "utf8"));
const root = dirname(manifest);

const sdk = await import("@naru-pub/sdk");
assert.equal(typeof sdk.createNaru, "function");
assert.equal(typeof sdk.NaruError, "function");
assert.throws(() => sdk.createNaru(), TypeError, "no site outside a page");
assert.equal(typeof sdk.createNaru({ site: "demo" }).query, "function");

for (const types of [exports["."].types, exports["./functions"].types]) {
  const text = await readFile(join(root, types), "utf8");
  assert.match(text, /@packageDocumentation/, types);
}

console.log(`@naru-pub/sdk ${version}: ok`);
