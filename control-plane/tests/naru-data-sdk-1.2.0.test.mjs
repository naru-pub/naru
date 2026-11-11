import { test } from "node:test";
import assert from "node:assert/strict";
import { browser } from "./sdk-browser.mjs";

// The 1.0.0 suite, run against 1.2.0: everything it describes still holds.
process.env.NARU_SDK_VERSION = "1.2.0";
await import("./naru-data-sdk.test.mjs");

// What 1.2.0 adds: visitors' uploads, and uploads kept as given.
const { createNaru, NaruError } = await import("../public/sdk/1.2.0/naru.js");

const SESSION =
  "naru:owner:https://naru.pub:alice:https://alice.naru.pub/admin.html";

/** Answers an upload's three requests: authorize, storage, finalize. */
const storage = ({ url, method }) => {
  if (url.host === "upload.example") return new Response(null, { status: 200 });
  if (method === "POST")
    return Response.json(
      {
        id: "0190f1a2-0000-7000-8000-000000000001",
        uploadUrl: "https://upload.example/signed",
        headers: { "Content-Type": "image/png" },
      },
      { status: 201 },
    );
  return Response.json({
    file: {
      id: "0190f1a2-0000-7000-8000-000000000001",
      url: "https://media.naru.pub/o/f.png",
      name: "drawing.png",
      contentType: "image/png",
      size: 700000,
    },
  });
};

/** createImageBitmap that records whether shrinking was tried. */
function watchShrinking() {
  const old = globalThis.createImageBitmap;
  const decoded = [];
  globalThis.createImageBitmap = async (file) => {
    decoded.push(file);
    return { width: 4096, height: 4096, close() {} };
  };
  return {
    decoded,
    restore: () => (globalThis.createImageBitmap = old),
  };
}

test("a visitor uploads with no token, through the client itself", async () => {
  await browser(async ({ calls, respond, local }) => {
    // Signed in as the owner too: naru.media is still the visitor's.
    local.set(
      SESSION,
      JSON.stringify({
        accessToken: "t".repeat(43),
        expiresAt: Date.now() + 3600000,
      }),
    );
    const naru = createNaru();
    assert.ok(await naru.auth.session());
    assert.deepEqual(Object.keys(naru.media), ["upload"]);
    respond(storage);
    const stored = await naru.media.upload(
      new File(["hi"], "note.txt", { type: "text/plain" }),
    );
    assert.deepEqual(stored, {
      id: "0190f1a2-0000-7000-8000-000000000001",
      url: "https://media.naru.pub/o/f.png",
      name: "drawing.png",
      contentType: "image/png",
      size: 700000,
    });
    assert.deepEqual(
      calls.map(({ method, url }) => [method, url.href]),
      [
        ["POST", "https://sdk.naru.pub/api/data/v1/alice/_files"],
        ["PUT", "https://upload.example/signed"],
        [
          "PUT",
          "https://sdk.naru.pub/api/data/v1/alice/_files/0190f1a2-0000-7000-8000-000000000001",
        ],
      ],
    );
    for (const call of calls) {
      assert.equal(call.headers?.Authorization, undefined);
      assert.equal(call.credentials, "omit");
    }
  });
});

test("a site that takes no visitors' uploads refuses before any bytes are sent", async () => {
  await browser(async ({ calls, respond }) => {
    respond(() =>
      Response.json(
        {
          error: {
            code: "ACCESS_DENIED",
            message: "This site does not take uploads from visitors.",
          },
        },
        { status: 403 },
      ),
    );
    await assert.rejects(
      createNaru().media.upload(
        new File(["x"], "a.png", { type: "image/png" }),
      ),
      (error) => error instanceof NaruError && error.code === "ACCESS_DENIED",
    );
    assert.equal(calls.length, 1);
  });
});

test("keepOriginal sends a large PNG as it is, where it would otherwise be re-encoded", async () => {
  const png = new File([new Uint8Array(700000)], "drawing.png", {
    type: "image/png",
  });
  const images = watchShrinking();
  try {
    await browser(async ({ calls, respond }) => {
      respond(storage);
      await createNaru().media.upload(png, { keepOriginal: true });
      assert.equal(images.decoded.length, 0);
      assert.deepEqual(JSON.parse(calls[0].body), {
        name: "drawing.png",
        contentType: "image/png",
        size: 700000,
      });
      assert.equal(calls[1].body, png);
    });
    // Without it the same file is decoded to be shrunk.
    await browser(async ({ respond }) => {
      respond(storage);
      await createNaru().media.upload(png);
      assert.equal(images.decoded.length, 1);
    });
  } finally {
    images.restore();
  }
});

test("keepOriginal is checked before anything is sent", async () => {
  await browser(async ({ calls }) => {
    await assert.rejects(
      createNaru().media.upload(new Blob(["x"]), { keepOriginal: "yes" }),
      TypeError,
    );
    assert.equal(calls.length, 0);
  });
});
