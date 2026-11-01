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
};

for (const [file, sha256] of Object.entries(FROZEN))
  test(`frozen SDK file ${file} is unchanged`, async () => {
    const bytes = await readFile(
      new URL(`../public/sdk/${file}`, import.meta.url),
    );
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
  });
