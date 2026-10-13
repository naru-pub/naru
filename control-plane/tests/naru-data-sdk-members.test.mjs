import { test } from "node:test";
import assert from "node:assert/strict";
import { browser } from "./sdk-browser.mjs";
import { createNaru, NaruError } from "../public/sdk/1.1.0/naru.js";

// Members, in SDK 1.1.0: a sign-in kept in the site's localStorage, for
// every page and tab, through Naru's member sign-in page.
const MEMBER = "naru:member:https://naru.pub:alice";
const OWNER =
  "naru:owner:https://naru.pub:alice:https://alice.naru.pub/admin.html";
const TOKEN = `m.${"t".repeat(43)}`;
const saveMember = (local, expiresAt = Date.now() + 3600000) =>
  local.set(
    MEMBER,
    JSON.stringify({ accessToken: TOKEN, expiresAt, memberId: "m-1" }),
  );
const emptyPage = () => Response.json({ documents: [], nextCursor: null });

test("signIn leaves for Naru's member sign-in, from the page with its query", async () => {
  await browser(
    async ({ calls, storage, location }) => {
      await createNaru().members.signIn();
      assert.equal(calls.length, 0);
      const approval = new URL(location.href);
      assert.equal(
        approval.origin + approval.pathname,
        "https://naru.pub/members/sign-in",
      );
      assert.deepEqual([...approval.searchParams.keys()].sort(), [
        "challenge",
        "redirectUri",
        "site",
        "state",
      ]);
      // The callback is the page; Naru does not take a query back.
      assert.equal(
        approval.searchParams.get("redirectUri"),
        "https://alice.naru.pub/board/",
      );
      const pending = JSON.parse(storage.get(`${MEMBER}:pending`));
      assert.equal(pending.state, approval.searchParams.get("state"));
      assert.equal(pending.address, "https://alice.naru.pub/board/?post=7#c3");
    },
    { href: "https://alice.naru.pub/board/?post=7#c3" },
  );
});

test("session finishes the sign-in, returns to the address it left, and keeps it for the site", async () => {
  const local = new Map();
  await browser(
    async ({ calls, respond, storage, location }) => {
      storage.set(
        `${MEMBER}:pending`,
        JSON.stringify({
          verifier: "v".repeat(43),
          state: "s1",
          startedAt: Date.now(),
          address: "https://alice.naru.pub/board/?post=7",
        }),
      );
      location.href = "https://alice.naru.pub/board/?code=c1&state=s1";
      respond(() =>
        Response.json({
          accessToken: TOKEN,
          expiresIn: 3600,
          expiresAt: 0,
          memberId: "m-1",
        }),
      );
      const member = await createNaru().members.session();
      assert.equal(member.id, "m-1");
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].url.href,
        "https://naru.pub/api/data-auth/v1/member-token",
      );
      assert.deepEqual(JSON.parse(calls[0].body), {
        code: "c1",
        verifier: "v".repeat(43),
        redirectUri: "https://alice.naru.pub/board/",
      });
      assert.equal(calls[0].credentials, "omit");
      assert.equal(location.href, "https://alice.naru.pub/board/?post=7");
      assert.equal(storage.has(`${MEMBER}:pending`), false);
      const saved = JSON.parse(local.get(MEMBER));
      assert.equal(saved.accessToken, TOKEN);
      assert.equal(saved.memberId, "m-1");
      assert.ok(saved.expiresAt > Date.now() + 3500000);
      // The code was used once: reloading restores, without a request.
      assert.equal((await createNaru().members.session()).id, "m-1");
      assert.equal(calls.length, 1);
    },
    { local },
  );
  // Another page and tab of the site: the same member.
  await browser(
    async ({ calls }) => {
      assert.equal((await createNaru().members.session()).id, "m-1");
      assert.equal(calls.length, 0);
    },
    { href: "https://alice.naru.pub/characters.html", local },
  );
});

test("an owner's and a member's sign-in on one page do not take each other's code", async () => {
  await browser(async ({ calls, respond, storage, location }) => {
    for (const key of [OWNER, MEMBER])
      storage.set(
        `${key}:pending`,
        JSON.stringify({
          verifier: "v".repeat(43),
          state: key === OWNER ? "owner" : "member",
          startedAt: Date.now(),
        }),
      );
    location.href = "https://alice.naru.pub/admin.html?code=c1&state=member";
    respond(() =>
      Response.json({ accessToken: TOKEN, expiresIn: 3600, memberId: "m-1" }),
    );
    const naru = createNaru();
    assert.equal(await naru.auth.session(), null);
    assert.equal(calls.length, 0);
    assert.equal(
      location.href,
      "https://alice.naru.pub/admin.html?code=c1&state=member",
    );
    assert.ok(storage.has(`${OWNER}:pending`));
    assert.equal((await naru.members.session()).id, "m-1");
    assert.equal(calls[0].url.pathname, "/api/data-auth/v1/member-token");
    assert.equal(location.href, "https://alice.naru.pub/admin.html");
  });
});

test("a sign-in that did not complete is an ordinary signed-out visit", async () => {
  for (const [query, startedAt] of [
    ["?error=access_denied&state=s1", Date.now()],
    ["?code=c1&state=s1", Date.now() - 11 * 60 * 1000],
  ])
    await browser(async ({ calls, storage, local, location }) => {
      storage.set(
        `${MEMBER}:pending`,
        JSON.stringify({ verifier: "v".repeat(43), state: "s1", startedAt }),
      );
      location.href = `https://alice.naru.pub/${query}`;
      assert.equal(await createNaru().members.session(), null);
      assert.equal(calls.length, 0);
      assert.equal(location.href, "https://alice.naru.pub/");
      assert.equal(local.size, 0);
    });
  await browser(async ({ respond, storage, location }) => {
    storage.set(
      `${MEMBER}:pending`,
      JSON.stringify({
        verifier: "v".repeat(43),
        state: "s1",
        startedAt: Date.now(),
      }),
    );
    location.href = "https://alice.naru.pub/?code=c1&state=s1";
    respond(() =>
      Response.json(
        { error: { code: "ACCESS_DENIED", message: "Supporters only." } },
        { status: 403 },
      ),
    );
    assert.equal(await createNaru().members.session(), null);
  });
});

test("a member writes with their token, and an ended sign-in is forgotten", async () => {
  await browser(async ({ calls, respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    const board = member.collection("board");
    assert.deepEqual(Object.keys(board).sort(), [
      "add",
      "count",
      "delete",
      "get",
      "getMany",
      "list",
      "pages",
      "set",
    ]);
    respond(() =>
      Response.json({
        id: "m-1",
        data: { nick: "bob" },
        revision: "r1.1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        createdBy: "m-1",
      }),
    );
    const profile = await board.set(member.id, { nick: "bob" });
    assert.equal(profile.createdBy, "m-1");
    assert.equal(calls[0].method, "PUT");
    assert.equal(
      calls[0].url.href,
      "https://naru.pub/api/data/v1/alice/board/m-1",
    );
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    respond(emptyPage);
    await board.list();
    assert.equal(calls[1].url.searchParams.get("fresh"), "1");
    // The server ended it: forgotten, so the next visit is signed out.
    respond(() =>
      Response.json(
        { error: { code: "AUTH_REQUIRED", message: "Sign in again." } },
        { status: 401 },
      ),
    );
    await assert.rejects(board.get("x"), { code: "AUTH_REQUIRED" });
    assert.equal(local.has(MEMBER), false);
    assert.equal(await createNaru().members.session(), null);
  });
});

test("an expired member session is not restored", async () => {
  await browser(async ({ calls, local }) => {
    saveMember(local, Date.now() - 1);
    assert.equal(await createNaru().members.session(), null);
    assert.equal(local.has(MEMBER), false);
    assert.equal(calls.length, 0);
  });
});

test("a renewed member token is kept for the site", async () => {
  await browser(async ({ respond, local }) => {
    saveMember(local, Date.now() + 1000);
    const member = await createNaru().members.session();
    respond(() =>
      Response.json(
        { documents: [], nextCursor: null },
        { headers: { "Naru-Owner-Expires-In": "86400" } },
      ),
    );
    await member.collection("board").list();
    assert.ok(JSON.parse(local.get(MEMBER)).expiresAt > Date.now() + 86000000);
  });
});

test("signing out ends the sign-in on every page, and stops the handle", async () => {
  await browser(async ({ calls, respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    respond(() => Response.json({ success: true }));
    await member.signOut();
    assert.equal(local.has(MEMBER), false);
    assert.equal(
      calls[0].url.href,
      "https://naru.pub/api/data-auth/v1/member-revoke",
    );
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    await assert.rejects(member.collection("board").list(), (error) => {
      assert.ok(error instanceof NaruError);
      assert.equal(error.code, "AUTH_REQUIRED");
      return true;
    });
    assert.equal(calls.length, 1);
  });
  // A newer sign-in made meanwhile is not erased by an older handle.
  await browser(async ({ local, respond }) => {
    saveMember(local);
    const older = await createNaru().members.session();
    local.set(
      MEMBER,
      JSON.stringify({
        accessToken: `m.${"n".repeat(43)}`,
        expiresAt: Date.now() + 3600000,
        memberId: "m-1",
      }),
    );
    respond(() => Response.json({ success: true }));
    await older.signOut();
    assert.ok(local.has(MEMBER));
  });
});

test("a member uploads with their token", async () => {
  await browser(async ({ calls, respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    respond((call) => {
      if (call.url.pathname.endsWith("/_files"))
        return Response.json({
          id: "0190f1a2-0000-7000-8000-000000000001",
          uploadUrl: "https://storage.invalid/put",
          headers: { "Content-Type": "text/plain" },
        });
      if (call.url.origin === "https://storage.invalid")
        return new Response(null, { status: 200 });
      return Response.json({
        file: {
          url: "https://media.naru.pub/x.txt",
          name: "x.txt",
          contentType: "text/plain",
          size: 2,
        },
      });
    });
    const file = await member.media.upload(
      new File(["hi"], "x.txt", { type: "text/plain" }),
    );
    assert.equal(file.url, "https://media.naru.pub/x.txt");
    assert.equal(file.id, "0190f1a2-0000-7000-8000-000000000001");
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[1].headers.Authorization, undefined);
    assert.equal(calls[2].method, "PUT");
  });
});

test("blocked storage signs a member in on this page only", async () => {
  await browser(async ({ respond, storage, location }) => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: blocked,
    });
    storage.set(
      `${MEMBER}:pending`,
      JSON.stringify({
        verifier: "v".repeat(43),
        state: "s1",
        startedAt: Date.now(),
      }),
    );
    location.href = "https://alice.naru.pub/?code=c1&state=s1";
    respond(() =>
      Response.json({ accessToken: TOKEN, expiresIn: 3600, memberId: "m-1" }),
    );
    const member = await createNaru().members.session();
    assert.equal(member.id, "m-1");
    respond(() => Response.json({ success: true }));
    await member.signOut();
  });
});

test("call posts its arguments to the function, and resolves with its result", async () => {
  await browser(async ({ calls, respond, local }) => {
    saveMember(local);
    const naru = createNaru();
    const member = await naru.members.session();
    respond(() => Response.json({ result: { ok: true, version: 3 } }));
    assert.deepEqual(await member.call("shop:buy", { item: "sword", qty: 1 }), {
      ok: true,
      version: 3,
    });
    assert.equal(calls[0].method, "POST");
    assert.equal(
      calls[0].url.href,
      "https://naru.pub/api/data/v1/alice/_call/shop:buy",
    );
    assert.deepEqual(JSON.parse(calls[0].body), {
      args: { item: "sword", qty: 1 },
    });
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    respond(() => Response.json({ result: null }));
    assert.equal(await member.call("shop:restock"), null);
    assert.deepEqual(JSON.parse(calls[1].body), { args: null });
    // A function may have written anything: this page's reads skip caches.
    respond(emptyPage);
    await naru.collection("anything").list();
    assert.equal(calls[2].url.searchParams.get("fresh"), "1");
    assert.equal(calls[2].cache, "no-store");
  });
});

test("call refuses a malformed name or non-JSON arguments before sending", async () => {
  await browser(async ({ calls, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    for (const name of ["buy", "a/b/c", "../buy", "shop/", "/buy", 7])
      await assert.rejects(member.call(name), TypeError);
    await assert.rejects(
      member.call("shop:buy", { at: new Date() }),
      TypeError,
    );
    assert.equal(calls.length, 0);
  });
});

test("a function's failure is a NaruError with the server's code", async () => {
  await browser(async ({ respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    respond(() =>
      Response.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "Function failed: Error: sold out",
          },
        },
        { status: 400 },
      ),
    );
    await assert.rejects(member.call("shop:buy"), {
      name: "NaruError",
      code: "INVALID_REQUEST",
      message: "Function failed: Error: sold out",
    });
  });
});

test("typed function failures preserve messages on call and read without retrying", async () => {
  await browser(async ({ respond, local, calls }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    respond(() =>
      Response.json(
        { error: { code: "CONFLICT", message: "품절입니다." } },
        { status: 409 },
      ),
    );
    for (const method of ["call", "read"]) {
      const before = calls.length;
      await assert.rejects(member[method]("shop:buy"), (error) => {
        assert.ok(error instanceof NaruError);
        assert.equal(error.code, "CONFLICT");
        assert.equal(error.message, "품절입니다.");
        return true;
      });
      assert.equal(calls.length, before + 1);
    }
  });
});

test("membership checks live state without forgetting a pending member's session", async () => {
  const local = new Map();
  saveMember(local);
  await browser(
    async ({ calls, respond }) => {
      const member = await createNaru().members.session();
      for (const status of ["pending", "approved", "banned"]) {
        respond(() => Response.json({ id: "m-1", status }));
        assert.deepEqual(await member.membership(), { id: "m-1", status });
        const call = calls.at(-1);
        assert.equal(
          call.url.origin + call.url.pathname,
          "https://naru.pub/api/membership/v1/alice",
        );
        assert.equal(call.method, "GET");
        assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(call.credentials, "omit");
      }
      assert.ok(local.has(MEMBER));
      await member.signOut();
      await assert.rejects(
        member.membership(),
        (e) => e.code === "AUTH_REQUIRED",
      );
    },
    { local },
  );
});

test("read posts to the read-only endpoint with member credentials", async () => {
  await browser(async ({ calls, respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    respond(() => Response.json({ result: { value: 1 } }));
    assert.deepEqual(await member.read("shop:catalog", { page: 1 }), {
      value: 1,
    });
    assert.equal(
      calls[0].url.href,
      "https://naru.pub/api/data/v1/alice/_read/shop:catalog",
    );
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(calls[0].body), { args: { page: 1 } });
    await assert.rejects(member.read("bad"), TypeError);
    await assert.rejects(
      member.read("shop:catalog", { date: new Date() }),
      TypeError,
    );
    assert.equal(calls.length, 1);
  });
});

test("media deletion sends a member credential once, validates IDs, and honors aborts", async () => {
  await browser(async ({ calls, respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    const id = "0190f1a2-0000-7000-8000-000000000001";
    respond(() => Response.json({ success: true }));
    assert.equal(await member.media.delete(id), undefined);
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].url.pathname, `/api/data/v1/alice/_files/${id}`);
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    await assert.rejects(
      member.media.delete("https://media.naru.pub/x"),
      TypeError,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      member.media.delete(id, { signal: controller.signal }),
      (e) => e.name === "AbortError",
    );
    const before = calls.length;
    respond(() =>
      Response.json(
        { error: { code: "UNAVAILABLE", message: "storage offline" } },
        { status: 503 },
      ),
    );
    await assert.rejects(
      member.media.delete(id),
      (e) => e.code === "UNAVAILABLE",
    );
    assert.equal(calls.length, before + 1);
  });
});

test("owners explicitly request media deletion at sign-in", async () => {
  await browser(async ({ location, calls }) => {
    await createNaru().auth.signIn({
      collections: ["posts"],
      mediaDelete: true,
    });
    assert.equal(new URL(location.href).searchParams.get("mediaDelete"), "1");
    assert.equal(calls.length, 0);
  });
});

test("media deletion can require the platform uploader to match an app cleanup record", async () => {
  await browser(async ({ calls, respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    respond(() => Response.json({ success: true }));
    await member.media.delete("0190f1a2-0000-7000-8000-000000000001", {
      uploadedBy: "0190f1a2-0000-7000-8000-000000000002",
    });
    assert.equal(
      calls[0].url.searchParams.get("uploadedBy"),
      "0190f1a2-0000-7000-8000-000000000002",
    );
    await member.media.delete("0190f1a2-0000-7000-8000-000000000001", {
      uploadedBy: null,
    });
    assert.equal(calls[1].url.searchParams.get("uploadedBy"), "owner");
  });
});

test("getMany sends one bounded read and preserves missing slots", async () => {
  await browser(async ({ calls, respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    respond(() =>
      Response.json({ documents: [{ id: "a" }, null, { id: "a" }] }),
    );
    assert.deepEqual(
      await member.collection("profiles").getMany(["a", "missing", "a"]),
      [{ id: "a" }, null, { id: "a" }],
    );
    assert.deepEqual(JSON.parse(calls[0].url.searchParams.get("ids")), [
      "a",
      "missing",
      "a",
    ]);
    assert.equal(calls.length, 1);
    await assert.rejects(
      member.collection("profiles").getMany(Array(101).fill("a")),
      TypeError,
    );
    assert.equal(calls.length, 1);
  });
});

test("nested module references use colon endpoints and reject ambiguous paths", async () => {
  await browser(async ({ calls, respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    respond(() => Response.json({ result: true }));
    for (const method of ["call", "read"]) {
      assert.equal(await member[method]("community/boards:list"), true);
      assert.equal(
        calls.at(-1).url.pathname,
        `/api/data/v1/alice/_${method}/community/boards:list`,
      );
      for (const value of [
        "shop/buy",
        "shop:",
        ":buy",
        "shop:buy:again",
        "/shop:buy",
        "shop//items:buy",
        "shop/../items:buy",
        "shop/./items:buy",
        "shop\\items:buy",
        "shop/%2f:buy",
      ])
        await assert.rejects(member[method](value), TypeError);
    }
    assert.equal(calls.length, 2);
  });
});
