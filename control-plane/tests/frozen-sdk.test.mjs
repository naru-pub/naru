import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// A frozen SDK's bytes: sites load them from their address, and build-sdk.mjs
// no longer looks at a version once it leaves VERSIONS. A change to what it
// does belongs in a new version. Only Naru's own moves can change one by hand
// (such as where its data API is), recorded in its release notes with the
// checksum that replaces the one here.
const FROZEN = {
  "1.0.0/naru.js":
    "05abcdc23b8afe915ffae6262f46b0478c470a1a0cc29947fad1dc6f9c9e47bf",
  "1.0.0/naru.d.ts":
    "834f017bbc2fed42e002fcdf2d8dce4b29298cdd62c9c79e7912d2ac2c396b08",
  "1.1.0/naru.js":
    "ef9ed0b6745e67200d9385c4d6a1f8a4c9135c40263a75ae2d6c64f6cda7ff6d",
  "1.1.0/naru.d.ts":
    "f0b5b53a9de75ba05f4fcb4ffb2758cae0df3312c60b18634e998e3c24410cc6",
  "1.1.0/functions.d.ts":
    "0ac893d4e72df03bfea1f682767e7bd32cbf490cc63b6733062d201faa4ff50a",
};

for (const [file, sha256] of Object.entries(FROZEN))
  test(`frozen SDK file ${file} is unchanged`, async () => {
    const bytes = await readFile(
      new URL(`../public/sdk/${file}`, import.meta.url),
    );
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
  });
