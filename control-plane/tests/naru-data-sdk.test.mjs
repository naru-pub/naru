import { test } from "node:test";
import assert from "node:assert/strict";
import { browser } from "./sdk-browser.mjs";

// Every release this suite describes runs it: 1.0.0 here, and 1.1.0 through
// naru-data-sdk-1.1.0.test.mjs, which sets the version and imports this file.
const VERSION = process.env.NARU_SDK_VERSION ?? "1.0.0";
const { createNaru, NaruError } = await import(
  `../public/sdk/${VERSION}/naru.js`
);

const collection = (name, options) => createNaru(options).collection(name);
const adminSession = (options) => createNaru(options).auth.session();
const signIn = ({ collections, ...options }) =>
  createNaru(options).auth.signIn({ collections });

const SESSION =
  "naru:owner:https://naru.pub:alice:https://alice.naru.pub/admin.html";

const written = (id = "one", version = 1) => ({
  id,
  revision: `r1.${version.toString(36)}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const revision = (version = 1) => `r1.${version.toString(36)}`;
const saveSession = (storage, expiresAt = Date.now() + 3600000) =>
  storage.set(
    SESSION,
    JSON.stringify({ accessToken: "t".repeat(43), expiresAt }),
  );
const emptyPage = () => Response.json({ documents: [], nextCursor: null });

test("a page on <site>.naru.pub needs no site; anywhere else must name one", async () => {
  await browser(async ({ calls, respond }) => {
    respond(emptyPage);
    await collection("posts").list();
    assert.equal(
      calls[0].url.href,
      "https://sdk.naru.pub/api/data/v1/alice/posts",
    );
    await collection("posts", { site: "bob" }).list();
    assert.equal(calls[1].url.pathname, "/api/data/v1/bob/posts");
    // An unfilled config's empty string means the same as leaving it out.
    await collection("posts", { site: "" }).list();
    assert.equal(calls[2].url.pathname, "/api/data/v1/alice/posts");
    // There is no other server to point it at, whatever options it is given.
    await collection("posts", {
      site: "alice",
      controlPlaneOrigin: "http://localhost:3000",
    }).list();
    assert.equal(calls[3].url.origin, "https://sdk.naru.pub");
  });
  await browser(
    async () => {
      assert.throws(() => collection("posts"), /site/);
      assert.throws(() => collection("posts", { site: "../bob" }), TypeError);
    },
    { href: "https://alice.example/" },
  );
});

test("documents are read and written with plain requests that carry no cookies", async () => {
  await browser(async ({ calls, respond, storage }) => {
    saveSession(storage);
    const document = { ...written(), data: { title: "hello" } };
    respond(({ method, body }) =>
      Response.json(
        method === "GET"
          ? { document }
          : method === "DELETE"
            ? { success: true }
            : { ...written(), data: JSON.parse(body).data },
      ),
    );
    const posts = collection("posts");
    assert.deepEqual(await posts.get("one"), {
      id: "one",
      data: { title: "hello" },
      revision: "r1.1",
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    });
    assert.deepEqual(await posts.add({ title: "new" }), {
      id: "one",
      data: { title: "new" },
      revision: "r1.1",
      createdAt: written().createdAt,
      updatedAt: written().updatedAt,
    });
    const owned = await adminSession();
    await owned
      .collection("posts")
      .set("one", { title: "x" }, { condition: { absent: true } });
    assert.equal(
      await owned.collection("posts").delete("one", {
        condition: { revision: revision(3) },
      }),
      undefined,
    );
    assert.deepEqual(
      calls.map(({ method, url }) => [method, url.pathname + url.search]),
      [
        ["GET", "/api/data/v1/alice/posts/one"],
        ["POST", "/api/data/v1/alice/posts"],
        ["PUT", "/api/data/v1/alice/posts/one?ifAbsent=1"],
        ["DELETE", "/api/data/v1/alice/posts/one?ifRevision=r1.3"],
      ],
    );
    assert.deepEqual(JSON.parse(calls[1].body), { data: { title: "new" } });
    assert.equal((await posts.add({ title: "revision" })).revision, "r1.1");
    assert.equal(calls[3].body, undefined);
    for (const [index, call] of calls.entries()) {
      assert.equal(call.credentials, "omit");
      assert.equal(call.redirect, "error");
      assert.equal(
        call.headers.Authorization,
        index === 2 || index === 3 ? `Bearer ${"t".repeat(43)}` : undefined,
      );
    }
    // ".." would resolve to another path once inside a URL.
    assert.throws(() => owned.collection("posts").set("..", {}), TypeError);
    assert.throws(() => collection("a/b"), TypeError);
  });
});

test("list sends only the query options that constrain something", async () => {
  await browser(async ({ calls, respond }) => {
    respond(() =>
      Response.json({ documents: [], nextCursor: "next", totalCount: 3 }),
    );
    const posts = collection("posts");
    await posts.list({ filter: {}, after: null });
    assert.deepEqual(
      [...calls[0].url.searchParams.keys()].filter((key) => key !== "fresh"),
      [],
    );
    const page = await posts.list({
      filter: { category: "일상", date: { gte: "2026-09-01" } },
      sort: [
        ["date", "desc"],
        [{ metadata: "createdAt" }, "desc"],
      ],
      size: 8,
      after: "next",
      includeTotal: true,
    });
    assert.equal(page.totalCount, 3);
    assert.equal(page.nextCursor, "next");
    const search = calls[1].url.searchParams;
    assert.deepEqual(JSON.parse(search.get("filter")), {
      category: "일상",
      date: { gte: "2026-09-01" },
    });
    assert.deepEqual(JSON.parse(search.get("sort")), [
      ["date", "desc"],
      [{ metadata: "createdAt" }, "desc"],
    ]);
    assert.equal(search.get("size"), "8");
    assert.equal(search.get("after"), "next");
    assert.equal(search.get("includeTotal"), "1");
  });
});

test("count asks for a one-document page and returns its total", async () => {
  await browser(async ({ calls, respond }) => {
    respond(() =>
      Response.json({ documents: [{}], nextCursor: "c", totalCount: 42 }),
    );
    const filter = { published: true };
    assert.equal(await collection("posts").count({ filter }), 42);
    // Earlier tests wrote posts, so this module may add its fresh flag.
    calls[0].url.searchParams.delete("fresh");
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
      filter: JSON.stringify(filter),
      size: "1",
      includeTotal: "1",
    });
    assert.equal(await collection("posts").count(), 42);
    assert.equal(calls[1].url.searchParams.has("filter"), false);
  });
});

test("pages follows nextCursor with the same query until it runs out", async () => {
  await browser(async ({ calls, respond }) => {
    const cursors = ["c1", "c2", null];
    respond(() =>
      Response.json({ documents: [], nextCursor: cursors[calls.length - 1] }),
    );
    const sort = [["date", "desc"]];
    const seen = [];
    for await (const page of collection("posts").pages({ sort, size: 100 }))
      seen.push(page.nextCursor);
    assert.deepEqual(seen, ["c1", "c2", null]);
    assert.deepEqual(
      calls.map(({ url }) => url.searchParams.get("after")),
      [null, "c1", "c2"],
    );
    for (const { url } of calls) {
      assert.equal(url.searchParams.get("sort"), JSON.stringify(sort));
      assert.equal(url.searchParams.get("size"), "100");
    }
    // Stopping early asks for nothing more; a given `after` is the start.
    calls.length = 0;
    for await (const page of collection("posts").pages({ after: "c1" })) {
      void page;
      break;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.searchParams.get("after"), "c1");
  });
});

test("revisions are passed through without client-side parsing", async () => {
  await browser(async ({ calls, respond, storage }) => {
    saveSession(storage);
    respond(() => Response.json({ ...written(), revision: "future.token" }));
    const posts = (await adminSession()).collection("posts");
    assert.equal((await posts.set("one", {})).revision, "future.token");
    await posts.delete("one", { condition: { revision: "future.token" } });
    assert.equal(calls[1].url.searchParams.get("ifRevision"), "future.token");
  });
});

test("errors have semantic codes and transport details stay diagnostic", async () => {
  await browser(async ({ respond, storage }) => {
    saveSession(storage);
    const posts = (await adminSession()).collection("posts");
    const failure = (status, code, message = "Failed.") =>
      respond(() => Response.json({ error: { code, message } }, { status }));
    failure(409, "CONFLICT", "Document version does not match.");
    await assert.rejects(
      posts.set("one", {}, { condition: { revision: revision(1) } }),
      (error) => {
        assert.ok(error instanceof NaruError);
        // Status is the server's detail, not part of the error.
        assert.equal("status" in error, false);
        assert.equal(error.code, "CONFLICT");
        assert.equal("retryable" in error, false);
        assert.equal(error.message, "Document version does not match.");
        return true;
      },
    );
    // The same status can mean a different thing; the server's code decides.
    failure(409, "QUOTA_EXCEEDED");
    await assert.rejects(posts.set("one", {}), { code: "QUOTA_EXCEEDED" });
    // A code from a later protocol falls back to what the status means here.
    failure(429, "SOMETHING_NEW");
    await assert.rejects(posts.set("one", {}), {
      code: "RATE_LIMITED",
    });
    failure(409, "SOMETHING_NEW");
    await assert.rejects(posts.set("one", {}), { code: "INVALID_REQUEST" });
    // A challenge or proxy page can answer 200; it is not an empty result.
    respond(() => new Response("<html>checking your browser</html>"));
    await assert.rejects(posts.get("one"), {
      code: "UNAVAILABLE",
      message: "The data API did not answer with JSON (HTTP 200).",
    });
    respond(() => Response.json(null));
    await assert.rejects(posts.list(), { code: "UNAVAILABLE" });
    respond(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await assert.rejects(posts.get("one"), {
      code: "UNAVAILABLE",
      message: "Database request failed (HTTP 502).",
    });
    respond(() => {
      throw new TypeError("offline");
    });
    // The platform's own Error cause, for a developer reading the console.
    await assert.rejects(posts.get("one"), (error) => {
      assert.equal(error.code, "UNAVAILABLE");
      assert.equal(error.cause.message, "offline");
      return true;
    });
    // The caller's signal reaches the request (with the SDK's own timeout),
    // and their abort stays an abort.
    const controller = new AbortController();
    respond(({ signal }) => {
      assert.equal(signal.aborted, true);
      throw signal.reason;
    });
    controller.abort();
    await assert.rejects(posts.list({ signal: controller.signal }), {
      name: "AbortError",
    });
    // A request Naru never answers fails as UNAVAILABLE once the SDK stops
    // waiting, with or without the caller's own signal.
    const timeout = AbortSignal.timeout;
    let expire;
    AbortSignal.timeout = () => {
      const timer = new AbortController();
      expire = () => timer.abort(new DOMException("timed out", "TimeoutError"));
      return timer.signal;
    };
    try {
      for (const options of [{}, { signal: new AbortController().signal }]) {
        respond(
          ({ signal }) =>
            new Promise((_, fail) =>
              signal.addEventListener("abort", () => fail(signal.reason)),
            ),
        );
        const waiting = posts.list(options);
        expire();
        await assert.rejects(waiting, {
          code: "UNAVAILABLE",
          message: "Naru did not answer in time.",
        });
      }
    } finally {
      AbortSignal.timeout = timeout;
    }
  });
});

test("a collection this browser wrote is read past the shared cache for the lifetime of the module", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await browser(async ({ calls, respond }) => {
      respond(({ method }) =>
        method === "POST" ? Response.json(written()) : emptyPage(),
      );
      const guestbook = collection("guestbook");
      await guestbook.list();
      await guestbook.add({ message: "hi" });
      await guestbook.list();
      // Unwritten here (the SDK's memory outlives one test, so not "posts").
      await collection("notes").list();
      // Another site's collection of the same name is a different entry.
      await collection("guestbook", { site: "bob" }).list();
      assert.deepEqual(
        calls.map((call) => call.cache),
        ["default", "no-store", "no-store", "default", "default"],
      );
      now += 10_001;
      await guestbook.list();
      assert.equal(calls.at(-1).cache, "no-store");
      assert.equal(calls.at(-1).url.searchParams.get("fresh"), "1");
      // A write whose response was lost may still have landed.
      respond(({ method }) => {
        if (method === "POST") throw new TypeError("offline");
        return emptyPage();
      });
      await assert.rejects(guestbook.add({ message: "again" }), {
        code: "UNAVAILABLE",
      });
      await guestbook.list();
      assert.equal(calls.at(-1).cache, "no-store");
    });
  } finally {
    Date.now = realNow;
  }
});

test("signIn refuses a malformed collection name before leaving the page", async () => {
  await browser(async ({ storage, location }) => {
    const before = location.href;
    await assert.rejects(
      signIn({ collections: ["posts", "bad name"] }),
      TypeError,
    );
    assert.equal(location.href, before);
    assert.equal(storage.size, 0);
  });
});

test("signIn leaves for approval with a PKCE challenge and no request", async () => {
  await browser(async ({ calls, respond, storage, location }) => {
    respond(() => {
      throw new TypeError("offline");
    });
    await signIn({ collections: ["posts", "drafts"] });
    // Naru's consent page, not the site, reports an unregistered callback.
    assert.equal(calls.length, 0);
    const approval = new URL(location.href);
    assert.equal(
      approval.origin + approval.pathname,
      "https://naru.pub/database/authorize",
    );
    assert.deepEqual([...approval.searchParams.keys()].sort(), [
      "challenge",
      "collections",
      "redirectUri",
      "site",
      "state",
    ]);
    assert.equal(approval.searchParams.get("site"), "alice");
    assert.equal(
      approval.searchParams.get("redirectUri"),
      "https://alice.naru.pub/admin.html",
    );
    const pending = JSON.parse(storage.get(`${SESSION}:pending`));
    // 1.1.0 also keeps the address the sign-in left from, to return to it.
    assert.deepEqual(Object.keys(pending).sort(), [
      ...(VERSION === "1.0.0" ? [] : ["address"]),
      "startedAt",
      "state",
      "verifier",
    ]);
    assert.equal(approval.searchParams.get("state"), pending.state);
    assert.equal(approval.searchParams.get("collections"), "posts,drafts");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(pending.verifier),
    );
    assert.equal(
      approval.searchParams.get("challenge"),
      Buffer.from(digest).toString("base64url"),
    );
  });
});

test("adminSession exchanges the returned code once and strips it from the address", async () => {
  await browser(async ({ calls, respond, storage, location }) => {
    storage.set(
      `${SESSION}:pending`,
      // A sign-in an older SDK started still carries its clientId; it finishes
      // without sending it.
      JSON.stringify({
        clientId: "client-1",
        verifier: "v".repeat(43),
        state: "s1",
        startedAt: Date.now(),
      }),
    );
    location.href = "https://alice.naru.pub/admin.html?tab=2&code=c1&state=s1";
    // Naru's clock says the token expires in an hour; this device's clock is a
    // day ahead. The session still lasts the hour, measured here.
    const before = Date.now();
    respond(() =>
      Response.json({
        accessToken: "t".repeat(43),
        expiresIn: 3600,
        expiresAt: before - 86400000 + 3600000,
      }),
    );
    const admin = await adminSession();
    assert.ok(admin);
    assert.equal(location.href, "https://alice.naru.pub/admin.html?tab=2");
    assert.equal(calls[0].url.href, "https://naru.pub/api/data-auth/v1/token");
    assert.deepEqual(JSON.parse(calls[0].body), {
      code: "c1",
      verifier: "v".repeat(43),
      redirectUri: "https://alice.naru.pub/admin.html",
    });
    assert.equal(storage.has(`${SESSION}:pending`), false);
    const stored = JSON.parse(storage.get(SESSION));
    assert.equal(stored.accessToken, "t".repeat(43));
    assert.ok(
      stored.expiresAt >= before + 3600000 &&
        stored.expiresAt <= Date.now() + 3600000,
    );
    // A reload restores the same deadline without a request.
    assert.ok(await adminSession());
    assert.equal(calls.length, 1);
  });
});

test("a sign-in that did not complete is an ordinary signed-out visit", async () => {
  for (const [query, startedAt] of [
    ["?code=c1&state=forged", Date.now()],
    // Consent took longer than the ten minutes a sign-in is kept.
    ["?code=c1&state=s1", Date.now() - 11 * 60 * 1000],
    ["?error=access_denied&state=s1", Date.now()],
  ])
    await browser(async ({ calls, storage, location }) => {
      storage.set(
        `${SESSION}:pending`,
        JSON.stringify({ state: "s1", startedAt }),
      );
      location.href = `https://alice.naru.pub/admin.html${query}`;
      const naru = createNaru();
      assert.equal(await naru.auth.session(), null);
      assert.equal(calls.length, 0);
      // From 1.1.0, a state this tab did not send is not its sign-in coming
      // back, so the address is the page's: an owner's and a member's sign-in
      // on one page must not take each other's code.
      assert.equal(
        location.href,
        VERSION !== "1.0.0" && query.includes("forged")
          ? `https://alice.naru.pub/admin.html${query}`
          : "https://alice.naru.pub/admin.html",
      );
      // Reloading the page is an ordinary signed-out visit.
      assert.equal(await naru.auth.session(), null);
    });
  // An exchange that fails on the network is also only a failed sign-in.
  await browser(async ({ calls, respond, storage, location }) => {
    storage.set(
      `${SESSION}:pending`,
      JSON.stringify({
        verifier: "v".repeat(43),
        state: "s1",
        startedAt: Date.now(),
      }),
    );
    location.href = "https://alice.naru.pub/admin.html?code=c1&state=s1";
    respond(() => {
      throw new TypeError("offline");
    });
    const naru = createNaru();
    assert.equal(await naru.auth.session(), null);
    assert.equal(calls.length, 1);
  });
});

test("a page's own ?code= is left alone when no sign-in was started here", async () => {
  await browser(async ({ calls, storage, location }) => {
    location.href =
      "https://alice.naru.pub/admin.html?code=SUMMER&error=none&state=x";
    assert.equal(await adminSession(), null);
    saveSession(storage);
    assert.ok(await adminSession());
    assert.equal(
      location.href,
      "https://alice.naru.pub/admin.html?code=SUMMER&error=none&state=x",
    );
    // A sign-in in progress does not claim a ?code= that carries no state.
    storage.set(
      `${SESSION}:pending`,
      JSON.stringify({ state: "s1", startedAt: Date.now() }),
    );
    location.href = "https://alice.naru.pub/admin.html?code=SUMMER";
    assert.ok(await adminSession());
    assert.equal(
      location.href,
      "https://alice.naru.pub/admin.html?code=SUMMER",
    );
    assert.equal(calls.length, 0);
  });
});

test("the admin client sends its token and forgets it when the session ends", async () => {
  await browser(async ({ calls, respond, storage }) => {
    assert.equal(await adminSession(), null);
    saveSession(storage, Date.now() - 1);
    assert.equal(await adminSession(), null);
    assert.equal(storage.has(SESSION), false);

    saveSession(storage);
    const admin = await adminSession();
    respond(() => Response.json(written()));
    await admin.collection("posts").set("one", { title: "x" });
    assert.equal(calls[0].headers.Authorization, `Bearer ${"t".repeat(43)}`);
    assert.equal(calls[0].cache, "no-store");

    respond(() =>
      Response.json(
        { error: { code: "AUTH_REQUIRED", message: "Revoked." } },
        { status: 401 },
      ),
    );
    await assert.rejects(admin.collection("posts").get("one"), {
      code: "AUTH_REQUIRED",
    });
    assert.equal(storage.has(SESSION), false);
    assert.equal(await adminSession(), null);
  });
  await browser(async ({ calls, storage }) => {
    const realNow = Date.now;
    saveSession(storage, realNow() + 1000);
    const admin = await adminSession();
    Date.now = () => realNow() + 2000;
    try {
      await assert.rejects(admin.collection("posts").list(), {
        code: "AUTH_REQUIRED",
      });
    } finally {
      Date.now = realNow;
    }
    assert.equal(calls.length, 0);
    assert.equal(storage.has(SESSION), false);
  });
});

test("a renewed token keeps working past the expiry the session was stored with", async () => {
  await browser(async ({ respond, storage }) => {
    saveSession(storage);
    const admin = await adminSession();
    // The instant is for older SDK files; this one adds the duration to its
    // own clock, so a server clock that disagrees does not matter.
    const before = Date.now();
    respond(() =>
      Response.json(written(), {
        headers: {
          "Naru-Owner-Expires": before - 86400000,
          "Naru-Owner-Expires-In": "7200",
        },
      }),
    );
    await admin.collection("posts").set("one", { title: "x" });
    const renewed = JSON.parse(storage.get(SESSION)).expiresAt;
    assert.ok(renewed >= before + 7200000 && renewed <= Date.now() + 7200000);
    // The renewal survives a reload, and the client itself now runs that long.
    const restored = await adminSession();
    assert.ok(restored);
    respond(() => Response.json(written()));
    await restored.collection("posts").set("two", { title: "y" });
    assert.equal(JSON.parse(storage.get(SESSION)).expiresAt, renewed);

    // A session stored by a newer sign-in is left alone, and an expiry that
    // does not move the deadline forward is ignored.
    saveSession(storage, renewed);
    storage.set(
      SESSION,
      JSON.stringify({ accessToken: "n".repeat(43), expiresAt: renewed }),
    );
    respond(() =>
      Response.json(written(), {
        headers: { "Naru-Owner-Expires-In": "10800" },
      }),
    );
    await admin.collection("posts").set("three", { title: "z" });
    assert.deepEqual(JSON.parse(storage.get(SESSION)), {
      accessToken: "n".repeat(43),
      expiresAt: renewed,
    });
  });
});

test("signing out forgets the session before revoking, and never erases a newer one", async () => {
  await browser(async ({ calls, respond, storage }) => {
    saveSession(storage);
    const admin = await adminSession();
    respond(() => {
      assert.equal(storage.has(SESSION), false);
      throw new TypeError("offline");
    });
    await assert.rejects(admin.signOut(), { code: "UNAVAILABLE" });
    assert.equal(calls[0].url.pathname, "/api/data-auth/v1/revoke");
    assert.equal(calls[0].headers.Authorization, `Bearer ${"t".repeat(43)}`);
    // The revoke never arrived, but this handle is done all the same.
    respond(() => Response.json(written()));
    await assert.rejects(admin.collection("posts").set("one", {}), {
      code: "AUTH_REQUIRED",
    });
    await assert.rejects(
      admin.batch([{ collection: "posts", delete: { id: "one" } }]),
      {
        code: "AUTH_REQUIRED",
      },
    );
    assert.equal(calls.length, 1);
    calls.length = 0;

    saveSession(storage);
    const older = await adminSession();
    storage.set(
      SESSION,
      JSON.stringify({
        accessToken: "n".repeat(43),
        expiresAt: Date.now() + 1e6,
      }),
    );
    respond(() => Response.json({}));
    await older.signOut();
    assert.equal(JSON.parse(storage.get(SESSION)).accessToken, "n".repeat(43));
  });
});

test("batch sends semantic writes and resolves with each write's metadata", async () => {
  await browser(async ({ calls, respond, storage }) => {
    saveSession(storage);
    const admin = await adminSession();
    respond(() =>
      Response.json({
        success: true,
        results: [{ ...written("hello"), data: {} }, null],
      }),
    );
    const writes = [
      {
        collection: "posts",
        set: { id: "hello", data: {}, condition: { absent: true } },
      },
      { collection: "drafts", delete: { id: "hello" } },
    ];
    // What the next conditional write quotes, without reading it back.
    assert.deepEqual(await admin.batch(writes), [written("hello"), null]);
    assert.equal(calls[0].url.pathname, "/api/data/v1/alice/_batch");
    assert.deepEqual(JSON.parse(calls[0].body), {
      operations: [
        {
          type: "set",
          collection: "posts",
          id: "hello",
          data: {},
          condition: { absent: true },
        },
        { type: "delete", collection: "drafts", id: "hello" },
      ],
    });
    // The public client reads both collections past the cache afterwards.
    respond(emptyPage);
    await collection("drafts").list();
    assert.equal(calls.at(-1).cache, "no-store");
  });
});

test("batch conditions are checked like single writes, before sending", async () => {
  await browser(async ({ calls, storage }) => {
    saveSession(storage);
    const admin = await adminSession();
    const posts = admin.collection("posts");
    for (const condition of [
      null,
      {},
      { revision: "" },
      { absent: false },
      { revision: "r1.1", absent: true },
    ]) {
      await assert.rejects(
        admin.batch([
          { collection: "posts", set: { id: "one", data: {}, condition } },
        ]),
        TypeError,
      );
      assert.throws(() => posts.set("one", {}, { condition }), TypeError);
    }
    // "Delete only if absent" could only ever do nothing.
    await assert.rejects(
      admin.batch([
        {
          collection: "posts",
          delete: { id: "one", condition: { absent: true } },
        },
      ]),
      TypeError,
    );
    await assert.rejects(
      posts.delete("one", { condition: { absent: true } }),
      TypeError,
    );
    assert.equal(calls.length, 0);
  });
});

// Stands in for the browser's decode and encode steps.
function fakeImages({
  width,
  height,
  encodes = ["image/webp", "image/jpeg"],
  size = 1000,
}) {
  const steps = [];
  const oldBitmap = globalThis.createImageBitmap;
  const oldCanvas = globalThis.OffscreenCanvas;
  globalThis.createImageBitmap = async (_file, options) => {
    steps.push({ decode: options });
    return { width, height, close() {} };
  };
  globalThis.OffscreenCanvas = class {
    getContext() {
      const context = {
        fillStyle: "",
        fillRect: () => steps.push({ fill: context.fillStyle }),
        drawImage: (_bitmap, _x, _y, w, h) => steps.push({ draw: [w, h] }),
      };
      return context;
    }
    async convertToBlob({ type, quality }) {
      steps.push({ encode: type, quality });
      // Browsers hand back PNG for a type they cannot encode.
      const produced = encodes.includes(type) ? type : "image/png";
      return new Blob([new Uint8Array(size)], { type: produced });
    }
  };
  return {
    steps,
    restore() {
      globalThis.createImageBitmap = oldBitmap;
      globalThis.OffscreenCanvas = oldCanvas;
    },
  };
}

async function upload(file, images) {
  let calls;
  let stored;
  try {
    await browser(async (page) => {
      calls = page.calls;
      saveSession(page.storage);
      const admin = await adminSession();
      page.respond(({ url, method }) => {
        if (url.host === "upload.example")
          return new Response(null, { status: 200 });
        if (method === "POST")
          return Response.json({
            id: "f1",
            uploadUrl: "https://upload.example/signed",
            headers: { "Content-Type": "image/webp" },
          });
        return Response.json({
          file: {
            id: "f1",
            name: "photo.webp",
            contentType: "image/webp",
            size: 3,
            url: "https://media",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        });
      });
      stored = await admin.media.upload(file);
    });
  } finally {
    images?.restore();
  }
  return { calls, stored, declared: JSON.parse(calls[0].body) };
}

test("upload authorizes, sends the bytes straight to storage, then finalizes", async () => {
  const file = new File(["hello"], "note.txt", { type: "text/plain" });
  const { calls, stored, declared } = await upload(file);
  // What was stored; managing it by id is the media library's.
  assert.deepEqual(stored, {
    ...(VERSION === "1.1.0" ? { id: "f1" } : {}),
    url: "https://media",
    name: "photo.webp",
    contentType: "image/webp",
    size: 3,
  });
  assert.deepEqual(
    calls.map(({ method, url }) => [method, url.href]),
    [
      ["POST", "https://sdk.naru.pub/api/data/v1/alice/_files"],
      ["PUT", "https://upload.example/signed"],
      ["PUT", "https://sdk.naru.pub/api/data/v1/alice/_files/f1"],
    ],
  );
  assert.deepEqual(declared, {
    name: "note.txt",
    contentType: "text/plain",
    size: 5,
  });
  assert.equal(calls[1].body, file);
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].credentials, "omit");
});

test("a large photo is shrunk to 2048px WebP before authorization", async () => {
  const images = fakeImages({ width: 4096, height: 3072 });
  const photo = new File([new Uint8Array(4_000_000)], "IMG_1.JPG", {
    type: "image/jpeg",
  });
  const { calls, declared } = await upload(photo, images);
  assert.deepEqual(images.steps[0], {
    decode: { imageOrientation: "from-image" },
  });
  assert.deepEqual(
    images.steps.find((step) => step.draw),
    { draw: [2048, 1536] },
  );
  assert.deepEqual(declared, {
    name: "IMG_1.webp",
    contentType: "image/webp",
    size: 1000,
  });
  assert.equal(calls[1].body.type, "image/webp");
});

test("photos fall back to JPEG, and are left alone when shrinking would not help", async () => {
  // No WebP encoder: JPEG, on white since JPEG has no transparency.
  const noWebp = fakeImages({
    width: 3000,
    height: 3000,
    encodes: ["image/jpeg"],
  });
  const png = new File([new Uint8Array(4_000_000)], "a.png", {
    type: "image/png",
  });
  const jpeg = await upload(png, noWebp);
  assert.equal(jpeg.declared.contentType, "image/jpeg");
  assert.equal(jpeg.declared.name, "a.jpeg");
  assert.ok(noWebp.steps.some((step) => step.fill === "#fff"));

  // Small and within 2048px: never re-encoded.
  const tiny = fakeImages({ width: 64, height: 64 });
  const icon = new File([new Uint8Array(1000)], "icon.png", {
    type: "image/png",
  });
  assert.equal((await upload(icon, tiny)).calls[1].body, icon);
  assert.equal(tiny.steps.filter((step) => step.encode).length, 0);

  // Re-encoding came out bigger: the original goes up instead.
  const dense = new File([new Uint8Array(600_000)], "d.webp", {
    type: "image/webp",
  });
  const bigger = fakeImages({ width: 1000, height: 1000, size: 700_000 });
  assert.equal((await upload(dense, bigger)).calls[1].body, dense);

  // HEIC cannot be stored as is, so it is converted whatever the size.
  const heic = new File([new Uint8Array(100)], "IMG.HEIC", {
    type: "image/heic",
  });
  const converted = fakeImages({ width: 100, height: 100, size: 5000 });
  assert.equal(
    (await upload(heic, converted)).declared.contentType,
    "image/webp",
  );
});

test("a HEIC photo this browser cannot convert fails before anything is sent", async () => {
  await browser(async ({ calls, storage }) => {
    saveSession(storage);
    const admin = await adminSession();
    // No HEIC decoder here, as in Chrome and Firefox.
    const old = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => {
      throw new DOMException("unsupported", "InvalidStateError");
    };
    try {
      await assert.rejects(
        admin.media.upload(
          new File([new Uint8Array(10)], "IMG.HEIC", { type: "image/heic" }),
        ),
        (error) => error instanceof TypeError && /Safari/.test(error.message),
      );
      // A typeless HEIC is recognized by its name and refused the same way.
      await assert.rejects(
        admin.media.upload(new File([new Uint8Array(10)], "IMG.heic")),
        /Safari/,
      );
    } finally {
      globalThis.createImageBitmap = old;
    }
    assert.equal(calls.length, 0);
  });
});

// Stands in for the browser's XMLHttpRequest; each test drives what storage
// does with the request it sent.
function fakeXhr(respond) {
  const sent = [];
  const old = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class {
    upload = {};
    headers = {};
    open(method, url) {
      Object.assign(this, { method, url });
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    // As the specification has it: aborting a request not yet sent fires
    // nothing, and sending it afterwards throws.
    abort() {
      this.aborted = true;
      if (this.body !== undefined) queueMicrotask(() => this.onabort?.());
    }
    send(body) {
      if (this.aborted)
        throw new DOMException("Not opened.", "InvalidStateError");
      this.body = body;
      sent.push(this);
      queueMicrotask(() => respond(this));
    }
  };
  return {
    sent,
    restore() {
      globalThis.XMLHttpRequest = old;
    },
  };
}
const answer = (request, status = 200, responseURL = request.url) =>
  Object.assign(request, { status, responseURL }).onload();

async function uploadWithProgress(respond, options = {}) {
  const xhr = fakeXhr(respond);
  const progress = [];
  let calls;
  try {
    await browser(async (page) => {
      calls = page.calls;
      saveSession(page.storage);
      const admin = await adminSession();
      page.respond(({ method }) =>
        method === "POST"
          ? Response.json({
              id: "f1",
              uploadUrl: "https://upload.example/signed?x=1",
              headers: { "Content-Type": "text/plain" },
            })
          : Response.json({
              file: {
                url: "https://media",
                name: "a.txt",
                contentType: "text/plain",
                size: 5,
              },
            }),
      );
      options.result = await admin.media
        .upload(new File(["hello"], "a.txt", { type: "text/plain" }), {
          onProgress: (event) => progress.push(event),
          ...options,
        })
        .catch((error) => ({ error }));
    });
  } finally {
    xhr.restore();
  }
  return { progress, calls, sent: xhr.sent, result: options.result };
}

test("upload reports its phases and the bytes sent to storage", async () => {
  const { progress, calls, sent, result } = await uploadWithProgress(
    (request) => {
      request.upload.onprogress({ loaded: 2 });
      request.upload.onprogress({ loaded: 5 });
      answer(request);
    },
  );
  assert.equal(result.url, "https://media");
  assert.deepEqual(progress, [
    { phase: "preparing" },
    { phase: "uploading", loaded: 0, total: 5 },
    { phase: "uploading", loaded: 2, total: 5 },
    { phase: "uploading", loaded: 5, total: 5 },
    { phase: "finishing" },
  ]);
  // The same PUT fetch would send: the signed headers, the file, no cookies.
  assert.equal(sent[0].method, "PUT");
  assert.equal(sent[0].url, "https://upload.example/signed?x=1");
  assert.deepEqual(sent[0].headers, { "Content-Type": "text/plain" });
  assert.equal(sent[0].body.name, "a.txt");
  assert.equal(sent[0].withCredentials, undefined);
  // Authorized and finalized through fetch; only the bytes went by XHR.
  assert.deepEqual(
    calls.map(({ method, url }) => [method, url.pathname]),
    [
      ["POST", "/api/data/v1/alice/_files"],
      ["PUT", "/api/data/v1/alice/_files/f1"],
    ],
  );
});

test("an upload with progress fails the way one without it does", async () => {
  for (const [respond, expected] of [
    [(request) => request.onerror(), { code: "UNAVAILABLE" }],
    [(request) => answer(request, 403), { code: "UNAVAILABLE" }],
    // Storage never redirects a signed upload, so one that did is refused.
    [
      (request) => answer(request, 200, "https://elsewhere.example/"),
      { code: "UNAVAILABLE" },
    ],
  ]) {
    const { result, calls, progress } = await uploadWithProgress(respond);
    assert.ok(result.error instanceof NaruError);
    assert.equal(result.error.code, expected.code);
    // Not finalized, and never reported as finishing.
    assert.equal(calls.length, 1);
    assert.equal(progress.at(-1).phase, "uploading");
  }
});

test("aborting from the first progress report still aborts the upload", async () => {
  const controller = new AbortController();
  const { result, sent } = await uploadWithProgress(() => {}, {
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.phase === "uploading") controller.abort();
    },
  });
  assert.equal(result.error.name, "AbortError");
  assert.equal(sent[0].aborted, true);
});

test("aborting an upload with progress stops the transfer natively", async () => {
  const controller = new AbortController();
  const { result, sent } = await uploadWithProgress(() => controller.abort(), {
    signal: controller.signal,
  });
  assert.equal(result.error.name, "AbortError");
  assert.equal(sent[0].aborted, true);
});

test("a throwing progress handler does not fail the upload", async () => {
  // Reported the way a browser reports an uncaught error, to window.onerror.
  const thrown = [];
  const old = globalThis.reportError;
  globalThis.reportError = (error) => thrown.push(error.message);
  try {
    const { result } = await uploadWithProgress(answer, {
      onProgress: () => {
        throw new Error("handler bug");
      },
    });
    assert.equal(result.url, "https://media");
    assert.ok(thrown.length >= 3 && thrown.every((m) => m === "handler bug"));
  } finally {
    globalThis.reportError = old;
  }
  await browser(async ({ calls, storage }) => {
    saveSession(storage);
    const admin = await adminSession();
    await assert.rejects(
      admin.media.upload(new Blob(["x"]), { onProgress: "yes" }),
      TypeError,
    );
    assert.equal(calls.length, 0);
  });
});

test("a failed transfer is reported and not finalized", async () => {
  await browser(async ({ calls, respond, storage }) => {
    saveSession(storage);
    const admin = await adminSession();
    respond(({ url }) =>
      url.host === "upload.example"
        ? new Response(null, { status: 403 })
        : Response.json({
            id: "f1",
            uploadUrl: "https://upload.example/signed",
            headers: {},
          }),
    );
    await assert.rejects(
      admin.media.upload(new Blob(["x"], { type: "text/plain" })),
      // Uploading again authorizes afresh, so this is worth retrying.
      { code: "UNAVAILABLE" },
    );
    assert.equal(calls.length, 2);
  });
});

test("non-JSON writes fail locally without losing data or masquerading as network errors", async () => {
  await browser(async ({ calls, storage, respond }) => {
    saveSession(storage);
    const admin = await adminSession();
    const posts = admin.collection("json-input");
    const cycle = {};
    cycle.self = cycle;
    class ChangedArray extends Array {
      toJSON() {
        return "changed";
      }
    }
    const accessor = Object.defineProperty({}, "x", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    for (const data of [
      undefined,
      NaN,
      Infinity,
      1n,
      new Date(),
      new Map(),
      new ChangedArray(1, 2),
      cycle,
      [1, , 3],
      { missing: undefined },
      { fn() {} },
      { value: Symbol() },
      accessor,
      { [Symbol()]: 1 },
    ]) {
      assert.throws(() => posts.set("one", data), TypeError);
      assert.throws(() => posts.add(data), TypeError);
      await assert.rejects(
        admin.batch([{ collection: "json-input", set: { id: "one", data } }]),
        TypeError,
      );
    }
    assert.equal(calls.length, 0);
    const shared = { value: 1 };
    const data = {
      left: shared,
      right: shared,
      values: [null, true, 0, "한글"],
    };
    respond(({ body }) =>
      Response.json({ ...written(), data: JSON.parse(body).data }),
    );
    assert.deepEqual((await posts.set("one", data)).data, data);
    assert.equal(calls.length, 1);
  });
});

test("visitor handles remain anonymous after signing in and expose no legacy namespace", async () => {
  await browser(async ({ storage, calls, respond }) => {
    const naru = createNaru();
    assert.equal("public" in naru, false);
    const notes = naru.collection("anonymous");
    saveSession(storage);
    const admin = await naru.auth.session();
    assert.equal("transaction" in admin, false);
    respond(() => emptyPage());
    await notes.list();
    await admin.collection("anonymous").list();
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.ok(calls[1].headers.Authorization);
  });
});
