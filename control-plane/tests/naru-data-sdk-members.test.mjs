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

test("a member queries and mutates with their token, and an ended sign-in is forgotten", async () => {
  await browser(async ({ calls, respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    // Members reach the site's data through its queries and mutations.
    assert.deepEqual(Object.keys(member).sort(), [
      "id",
      "media",
      "mutate",
      "query",
      "signOut",
      "subscribe",
    ]);
    respond(() => Response.json({ result: { id: 4 } }));
    assert.deepEqual(await member.mutate("board:write", { title: "hi" }), {
      id: 4,
    });
    assert.equal(calls[0].method, "POST");
    assert.equal(
      calls[0].url.href,
      "https://sdk.naru.pub/api/data/v1/alice/_mutate/board:write",
    );
    assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
    // The server ended it: forgotten, so the next visit is signed out.
    respond(() =>
      Response.json(
        { error: { code: "AUTH_REQUIRED", message: "Sign in again." } },
        { status: 401 },
      ),
    );
    await assert.rejects(member.query("board:recent"), {
      code: "AUTH_REQUIRED",
    });
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
        { result: [] },
        { headers: { "Naru-Owner-Expires-In": "86400" } },
      ),
    );
    await member.query("board:recent");
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
    await assert.rejects(member.query("board:recent"), (error) => {
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

test("query and mutate post to the site's queries and mutations, signed in or not", async () => {
  await browser(async ({ calls, respond, local }) => {
    const naru = createNaru();
    respond(() => Response.json({ result: [{ id: 1 }] }));
    assert.deepEqual(await naru.query("board:recent", { board: "free" }), [
      { id: 1 },
    ]);
    assert.equal(
      calls[0].url.href,
      "https://sdk.naru.pub/api/data/v1/alice/_query/board:recent",
    );
    assert.equal(calls[0].headers.Authorization, undefined);
    saveMember(local);
    const member = await naru.members.session();
    respond(() => Response.json({ result: 4 }));
    assert.equal(await member.mutate("board:write", { title: "넷째" }), 4);
    assert.equal(
      calls[1].url.href,
      "https://sdk.naru.pub/api/data/v1/alice/_mutate/board:write",
    );
    assert.equal(calls[1].headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(calls[1].body), { args: { title: "넷째" } });
    // No arguments are sent as null, which the code receives as undefined.
    respond(() => Response.json({ result: null }));
    assert.equal(await member.mutate("board:tidy"), null);
    assert.deepEqual(JSON.parse(calls[2].body), { args: null });
    // Tables are not collections: a page's collection reads keep caches.
    respond(emptyPage);
    await naru.collection("posts").list();
    assert.equal(calls[3].url.searchParams.get("fresh"), null);
  });
});

test("query and mutate refuse a malformed name or non-JSON arguments before sending", async () => {
  await browser(async ({ calls, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    for (const method of ["query", "mutate"]) {
      for (const name of ["buy", "a/b/c", "../buy", "shop/", "/buy", 7])
        await assert.rejects(member[method](name), TypeError);
      await assert.rejects(
        member[method]("shop:buy", { at: new Date() }),
        TypeError,
      );
    }
    assert.equal(calls.length, 0);
  });
});

test("site code's failure is a NaruError with the server's code", async () => {
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
    // Code that threw is Naru's failure, worded for visitors; the server's
    // account stays for the developer.
    await assert.rejects(member.mutate("shop:buy"), (error) => {
      assert.equal(error.name, "NaruError");
      assert.equal(error.code, "INVALID_REQUEST");
      assert.equal(error.message, "요청을 처리할 수 없습니다.");
      assert.equal(error.cause.message, "Function failed: Error: sold out");
      return true;
    });
  });
});

test("ctx.fail's failures keep their message and details without retrying", async () => {
  await browser(async ({ respond, local, calls }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    respond(() =>
      Response.json(
        {
          error: {
            code: "CONFLICT",
            message: "품절입니다.",
            details: { reason: "sold_out" },
            site: true,
          },
        },
        { status: 409 },
      ),
    );
    await assert.rejects(member.mutate("shop:buy"), (error) => {
      assert.ok(error instanceof NaruError);
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.message, "품절입니다.");
      assert.deepEqual(error.details, { reason: "sold_out" });
      return true;
    });
    assert.equal(calls.length, 1);
    respond(() =>
      Response.json(
        { error: { code: "CONFLICT", message: "No." } },
        { status: 409 },
      ),
    );
    await assert.rejects(member.query("shop:catalog"), (error) => {
      assert.equal(error.details, undefined);
      assert.ok(!("details" in error));
      return true;
    });
  });
});

test("while Naru's server is away, an owner's read and write fail as UNAVAILABLE; the session stays", async () => {
  await browser(async ({ calls, respond, storage }) => {
    storage.set(
      OWNER,
      JSON.stringify({
        accessToken: "o".repeat(43),
        expiresAt: Date.now() + 3600000,
      }),
    );
    const admin = await createNaru().auth.session();
    respond(() =>
      Response.json(
        {
          error: {
            code: "UNAVAILABLE",
            message: "The site database is unavailable. Try again shortly.",
          },
        },
        { status: 503 },
      ),
    );
    await assert.rejects(admin.collection("board").list(), {
      code: "UNAVAILABLE",
    });
    // Nothing is asked again without the sign-in.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.Authorization, `Bearer ${"o".repeat(43)}`);
    await assert.rejects(admin.collection("board").add({ text: "hi" }), {
      code: "UNAVAILABLE",
    });
    assert.equal(calls.length, 2);
    assert.ok(storage.has(OWNER));
  });
});

test("a member the site has not approved learns so from the refusal", async () => {
  await browser(async ({ respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    respond(() =>
      Response.json(
        {
          error: {
            code: "ACCESS_DENIED",
            message: "Membership is awaiting approval.",
            details: { membership: "pending" },
          },
        },
        { status: 403 },
      ),
    );
    await assert.rejects(member.query("board:recent"), (error) => {
      assert.equal(error.code, "ACCESS_DENIED");
      assert.deepEqual(error.details, { membership: "pending" });
      return true;
    });
    // The session stays, for when the owner approves.
    assert.ok(local.has(MEMBER));
  });
});

test("a member's live queries reconnect with fresh tickets and stop when access ends", async () => {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = new URL(url);
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(text) {
      this.sent.push(text);
    }
    close(code) {
      this.closedWith = code;
    }
  }
  const saved = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    await browser(async ({ calls, respond, local }) => {
      saveMember(local);
      const naru = createNaru();
      const member = await naru.members.session();
      let tickets = 0;
      respond(() => Response.json({ ticket: `ticket-${++tickets}` }));
      const results = [];
      const live = member.subscribe("board:mine", null, (result) =>
        results.push(result),
      );
      await new Promise((done) => setTimeout(done, 0));
      assert.equal(calls[0].url.pathname, "/api/data/v1/alice/_live");
      assert.equal(calls[0].method, "POST");
      assert.equal(
        sockets[0].url.href,
        "wss://sdk.naru.pub/api/data/v1/alice/_live?ticket=ticket-1",
      );
      sockets[0].onmessage({ data: '{"type":"result","id":"1","result":2}' });
      sockets[0].onmessage({ data: "pong" });
      // Anything else a connection hears is no live query's.
      sockets[0].onmessage({ data: '{"type":"notice","data":{"unread":1}}' });
      assert.deepEqual(results, [2]);
      // A dropped connection comes back with a new ticket.
      sockets[0].onclose({ code: 1006 });
      await new Promise((done) => setTimeout(done, 1100));
      assert.equal(sockets.length, 2);
      assert.match(sockets[1].url.search, /ticket=ticket-2/);
      // Access ended: no more reconnecting.
      sockets[1].onclose({ code: 4003 });
      await new Promise((done) => setTimeout(done, 1100));
      assert.equal(sockets.length, 2);
      live.close();
      // Visitors connect without a ticket; there are no topics to hear.
      const visitor = naru.subscribe("board:recent", null, () => {});
      await new Promise((done) => setTimeout(done, 0));
      assert.equal(
        sockets[2].url.href,
        "wss://sdk.naru.pub/api/data/v1/alice/_live",
      );
      visitor.close();
      assert.equal(sockets[2].closedWith, 1000);
      assert.equal(naru.live, undefined);
    });
  } finally {
    globalThis.WebSocket = saved;
  }
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

test("nested module references use colon endpoints and reject ambiguous paths", async () => {
  await browser(async ({ calls, respond, local }) => {
    saveMember(local);
    const member = await createNaru().members.session();
    respond(() => Response.json({ result: true }));
    for (const method of ["query", "mutate"]) {
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

test("live queries share one connection, are asked again on reconnect, and close with the last", async () => {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = new URL(url);
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(text) {
      this.sent.push(text);
    }
    close(code) {
      this.closedWith = code;
    }
  }
  const saved = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    await browser(async () => {
      const naru = createNaru();
      const results = [];
      const errors = [];
      const recent = naru.subscribe(
        "board:recent",
        { board: "free" },
        (result) => results.push(result),
        { onError: (error) => errors.push(error) },
      );
      // No args at all is null, as a query's are.
      const mine = naru.subscribe("board:mine", undefined, () => {});
      await new Promise((done) => setTimeout(done, 0));
      assert.equal(sockets.length, 1);
      assert.equal(
        sockets[0].url.href,
        "wss://sdk.naru.pub/api/data/v1/alice/_live",
      );
      const asked = () =>
        sockets
          .at(-1)
          .sent.filter((text) => text !== "ping")
          .map((text) => JSON.parse(text));
      assert.deepEqual(asked(), [
        {
          type: "subscribe",
          id: "1",
          query: "board:recent",
          args: { board: "free" },
        },
        { type: "subscribe", id: "2", query: "board:mine", args: null },
      ]);
      sockets[0].onmessage({ data: '{"type":"result","id":"1","result":[1]}' });
      sockets[0].onmessage({
        data: '{"type":"error","id":"1","error":{"status":403,"code":"ACCESS_DENIED","message":"운영진만","site":true}}',
      });
      assert.deepEqual(results, [[1]]);
      assert.equal(errors[0].code, "ACCESS_DENIED");
      assert.equal(errors[0].message, "운영진만");
      // Reconnecting asks for both again.
      sockets[0].onclose({ code: 1006 });
      await new Promise((done) => setTimeout(done, 1100));
      assert.equal(sockets.length, 2);
      assert.equal(asked().length, 2);
      recent.close();
      assert.deepEqual(asked().at(-1), { type: "unsubscribe", id: "1" });
      assert.equal(sockets[1].closedWith, undefined);
      mine.close();
      assert.equal(sockets[1].closedWith, 1000);
      assert.throws(() => naru.subscribe("recent", null, () => {}), TypeError);
    });
  } finally {
    globalThis.WebSocket = saved;
  }
});
