/** @jest-environment node */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { callSiteObject, eraseSiteData } from "@/lib/edge/client";
import {
  executeBatch,
  executeCall,
  executeData,
  executeLiveTicket,
  listCollections,
} from "../service";
import { manageMembership } from "../membership";
import { digest } from "../owner-auth";
import { encodeRevision } from "../protocol";
import {
  approveMemberSignIn,
  exchangeMemberCode,
  MEMBER_TOKEN_CAP_SECONDS,
  MEMBER_TOKEN_SECONDS,
  memberSignInInput,
  previewMemberSignIn,
  revokeMemberToken,
} from "../member-auth";
import { executeMedia, MEMBER_UPLOADS_PER_HOUR, mediaStorage } from "../media";
import { runMediaRelease } from "../media-releases";
import { mediaDeletionStorage, cleanupDeletedMedia } from "../media-deletion";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";

// Members, end to end: sign-in and tokens in PostgreSQL, what a member may
// do in the site's Durable Object (scripts/with-edge-worker.sh).
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;
afterAll(() => db.destroy());

const insertUser = async (login: string, supporter = true) =>
  (
    await sql<{
      id: string;
    }>`insert into users(login_name, supporter_comp) values (${login}, ${supporter}) returning id`.execute(
      db,
    )
  ).rows[0].id;

integration("site members", () => {
  let ready = false;
  let owner: string;
  const users: Record<string, string> = {};
  const origin = "https://alice.example";
  const redirectUri = `${origin}/board/`;
  const verifier = "v".repeat(43);
  const input = (extra = {}) =>
    memberSignInInput({
      site: "alice",
      redirectUri,
      state: "s".repeat(43),
      challenge: digest(verifier),
      ...extra,
    });
  const code = async (login: string, extra = {}) =>
    new URL(
      (
        await approveMemberSignIn(
          users[login],
          `${login}-session`,
          input(extra),
        )
      ).redirect,
    ).searchParams.get("code")!;
  const exchange = (
    value: string,
    extra = {},
    requestOrigin: string | null = origin,
  ) =>
    exchangeMemberCode(
      { code: value, verifier, redirectUri, ...extra },
      requestOrigin,
    );
  const signIn = async (login: string) => exchange(await code(login));
  const as = (
    token: string | undefined,
    method: string,
    path: string[],
    body?: Record<string, unknown>,
    extra = {},
  ) =>
    executeData({
      site: "alice",
      path,
      method,
      body,
      ...(token ? { bearer: { token, origin } } : {}),
      ...extra,
    }) as Promise<Record<string, any>>;
  const owned = (method: string, path: string[], body?: object) =>
    executeData({
      site: "alice",
      path,
      method,
      body: body as Record<string, unknown>,
      adminUserId: owner,
    }) as Promise<Record<string, any>>;

  beforeAll(async () => {
    await setupTestDatabase();
    ready = true;
    await eraseSiteData("alice");
    owner = await insertUser("alice");
    for (const login of ["bob", "carol", "dave", "read-budget", "fern"])
      users[login] = await insertUser(login);
    users.erin = await insertUser("erin");
    users.ivy = await insertUser("ivy", false);
    users.alice = owner;
    for (const [login, id] of Object.entries(users))
      await sql`insert into sessions values (${`${login}-session`}, ${id}, now() + interval '60 days')`.execute(
        db,
      );
    await sql`insert into custom_domains(user_id,hostname,verified_at,cloudflare_status,ssl_status) values (${owner}, 'alice.example', now(), 'active', 'active')`.execute(
      db,
    );
    for (const [name, read, write] of [
      ["board", "member", "member"],
      ["guestbook", "world", "create"],
      ["wall", "world", "world"],
      ["notes", "admin", "admin"],
      ["public", "world", "member"],
    ])
      await owned("POST", [], { name, read, write });
  });
  afterAll(async () => {
    if (ready) await teardownTestDatabase();
  });

  test("sign-in is for a page of a site that has the database", async () => {
    expect(await previewMemberSignIn(users.bob, input())).toEqual({
      site: "alice",
      mayJoin: true,
      needsVerifiedEmail: false,
    });
    // The site's own subdomain is one of its pages; another site's is not.
    await expect(
      previewMemberSignIn(
        users.bob,
        input({ redirectUri: "http://alice.naru.pub/" }),
      ),
    ).resolves.toMatchObject({ site: "alice" });
    await expect(
      previewMemberSignIn(
        users.bob,
        input({ redirectUri: "https://evil.example/" }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      previewMemberSignIn(users.bob, input({ site: "nobody" })),
    ).rejects.toMatchObject({ status: 404 });
    // A site without the database has no members.
    await expect(
      previewMemberSignIn(users.bob, input({ site: "ivy" })),
    ).rejects.toMatchObject({ status: 404 });
    for (const bad of [
      { challenge: "short" },
      { state: "x" },
      { redirectUri: `${redirectUri}?next=1` },
    ])
      expect(() => input(bad)).toThrow();
  });

  test("a member has one id per site, and a single-use code becomes a token", async () => {
    const first = await signIn("bob");
    expect(first).toEqual({
      accessToken: expect.stringMatching(/^m\.[A-Za-z0-9_-]{43}$/),
      expiresIn: expect.any(Number),
      expiresAt: expect.any(Number),
      memberId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect((await signIn("bob")).memberId).toBe(first.memberId);
    expect((await signIn("carol")).memberId).not.toBe(first.memberId);
    // Nothing of the account reaches the site but that id.
    const { rows } = await sql<{
      user_id: string;
    }>`select user_id from site_members where id = ${first.memberId}`.execute(
      db,
    );
    expect(String(rows[0].user_id)).toBe(String(users.bob));
    const once = await code("bob");
    await exchange(once);
    await expect(exchange(once)).rejects.toMatchObject({ status: 401 });
    // The verifier, the page and its origin all have to match.
    for (const [extra, requestOrigin] of [
      [{ verifier: "w".repeat(43) }, origin],
      [{ redirectUri: `${origin}/other/` }, origin],
      [{}, "https://evil.example"],
      [{}, null],
    ] as const)
      await expect(
        exchange(await code("bob"), extra, requestOrigin),
      ).rejects.toMatchObject({ status: 401 });
    // The callback is one page however it is addressed.
    await expect(
      exchange(await code("bob"), {
        redirectUri: `${origin}/board/index.html`,
      }),
    ).resolves.toMatchObject({ memberId: first.memberId });
    expect(first.expiresIn).toBeGreaterThan(MEMBER_TOKEN_SECONDS - 5);
    const late = await code("bob");
    await sql`update site_member_codes set expires_at = now() - interval '1 second' where hash = ${digest(late)}`.execute(
      db,
    );
    await expect(exchange(late)).rejects.toMatchObject({ status: 401 });
  });

  test("a token works only from its page's origin, until it is revoked or its Naru session ends", async () => {
    const { accessToken } = await signIn("bob");
    await expect(as(accessToken, "GET", ["board"])).resolves.toMatchObject({
      documents: [],
    });
    await expect(
      executeData({
        site: "alice",
        path: ["board"],
        method: "GET",
        bearer: { token: accessToken, origin: "https://evil.example" },
      }),
    ).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
    // Another site does not know it.
    await expect(
      executeData({
        site: "bob",
        path: ["board"],
        method: "GET",
        bearer: { token: accessToken, origin },
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      revokeMemberToken(accessToken, "https://evil.example"),
    ).rejects.toMatchObject({ status: 401 });
    await revokeMemberToken(accessToken, origin);
    await revokeMemberToken(accessToken, origin);
    await expect(as(accessToken, "GET", ["board"])).rejects.toMatchObject({
      status: 401,
    });
    const second = await signIn("bob");
    await sql`update sessions set expires_at = now() - interval '1 second' where id = 'bob-session'`.execute(
      db,
    );
    await expect(
      as(second.accessToken, "GET", ["board"]),
    ).rejects.toMatchObject({ status: 401 });
    await sql`update sessions set expires_at = now() + interval '60 days' where id = 'bob-session'`.execute(
      db,
    );
    // A deleted account's member stops at once.
    const third = await signIn("dave");
    await sql`update users set deleted_at = now() where id = ${users.dave}`.execute(
      db,
    );
    await expect(as(third.accessToken, "GET", ["board"])).rejects.toMatchObject(
      { status: 401 },
    );
    await sql`update users set deleted_at = null where id = ${users.dave}`.execute(
      db,
    );
  });

  test("using a token renews it past halfway, never past its cap or session", async () => {
    const { accessToken } = await signIn("carol");
    const hash = digest(accessToken);
    const expiry = async () =>
      (
        await db
          .selectFrom("site_member_tokens")
          .select("expires_at")
          .where("hash", "=", hash)
          .executeTakeFirstOrThrow()
      ).expires_at.getTime();
    const before = await expiry();
    const bearer = { token: accessToken, origin } as {
      token: string;
      origin: string;
      expiresAt?: number;
    };
    await executeData({
      site: "alice",
      path: ["board"],
      method: "GET",
      bearer,
    });
    expect(bearer.expiresAt).toBeUndefined();
    expect(await expiry()).toBe(before);
    // Past the halfway mark: pushed out a full window.
    await sql`update site_member_tokens set expires_at = now() + interval '1 day' where hash = ${hash}`.execute(
      db,
    );
    await executeData({
      site: "alice",
      path: ["board"],
      method: "GET",
      bearer,
    });
    expect(bearer.expiresAt).toBeGreaterThan(
      Date.now() + (MEMBER_TOKEN_SECONDS - 60) * 1000,
    );
    // Near the cap, only up to it.
    await sql`update site_member_tokens set expires_at = now() + interval '1 day',
      issued_at = now() - ${sql.raw(`interval '${MEMBER_TOKEN_CAP_SECONDS - 2 * 86400} seconds'`)} where hash = ${hash}`.execute(
      db,
    );
    delete bearer.expiresAt;
    await executeData({
      site: "alice",
      path: ["board"],
      method: "GET",
      bearer,
    });
    expect(bearer.expiresAt).toBeLessThan(Date.now() + 2 * 86400 * 1000 + 5000);
    expect(bearer.expiresAt).toBeGreaterThan(
      Date.now() + 2 * 86400 * 1000 - 5000,
    );
  });

  test("members need a supporter plan, also once signed in", async () => {
    // An account without one is told so, and cannot join.
    expect(await previewMemberSignIn(users.ivy, input())).toMatchObject({
      mayJoin: false,
    });
    await expect(
      approveMemberSignIn(users.ivy, "ivy-session", input()),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    // A member whose support ends loses access on the next request, and
    // gets it back when it resumes.
    const member = await signIn("erin");
    await expect(
      as(member.accessToken, "GET", ["board"]),
    ).resolves.toBeDefined();
    await sql`update users set supporter_comp = false where id = ${users.erin}`.execute(
      db,
    );
    try {
      await expect(
        as(member.accessToken, "GET", ["board"]),
      ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
      await expect(code("erin")).rejects.toMatchObject({ status: 403 });
    } finally {
      await sql`update users set supporter_comp = true where id = ${users.erin}`.execute(
        db,
      );
    }
    await expect(
      as(member.accessToken, "GET", ["board"]),
    ).resolves.toBeDefined();
  });

  test("operators can exempt a site, letting accounts without a plan be members", async () => {
    await sql`update users set site_members_free = true where id = ${owner}`.execute(
      db,
    );
    try {
      expect(await previewMemberSignIn(users.ivy, input())).toMatchObject({
        mayJoin: true,
      });
      const free = await signIn("ivy");
      await expect(
        as(free.accessToken, "GET", ["board"]),
      ).resolves.toBeDefined();
      // Withdrawing the exemption reaches members already signed in.
      await sql`update users set site_members_free = false where id = ${owner}`.execute(
        db,
      );
      await expect(
        as(free.accessToken, "GET", ["board"]),
      ).rejects.toMatchObject({
        status: 403,
        code: "ACCESS_DENIED",
      });
    } finally {
      await sql`update users set site_members_free = false where id = ${owner}`.execute(
        db,
      );
    }
  });

  test("approval and bans govern existing tokens across data, functions and uploads", async () => {
    const member = await signIn("erin");
    const bearer = { token: member.accessToken, origin };
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      file: "membership",
      source: "export function ping() { return true; }",
    });
    try {
      for (const status of ["pending", "banned"] as const) {
        await manageMembership(owner, "PATCH", { id: member.memberId, status });
        for (const [method, path, body] of [
          ["GET", ["board"], undefined],
          ["GET", ["board", "anything"], undefined],
          ["POST", ["board"], { data: "denied" }],
          ["PUT", ["board", member.memberId], { data: "denied" }],
          ["DELETE", ["board", member.memberId], undefined],
          ["GET", ["wall"], undefined],
        ] as const) {
          await expect(
            as(member.accessToken, method, [...path], body),
          ).rejects.toMatchObject({
            status: 403,
            code: "ACCESS_DENIED",
            // The refusal says why, so the page needs no status request.
            details: { membership: status },
          });
        }
        await expect(
          executeCall({
            site: "alice",
            method: "POST",
            path: ["membership:ping"],
            bearer,
          }),
        ).rejects.toMatchObject({
          status: 403,
          code: "ACCESS_DENIED",
          details: { membership: status },
        });
        for (const [method, path] of [
          ["POST", []],
          ["PUT", [crypto.randomUUID()]],
        ] as const)
          await expect(
            executeMedia({
              site: "alice",
              method,
              path: [...path],
              bearer,
              body: { name: "x.png", contentType: "image/png", size: 3 },
            }),
          ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
        await expect(as(undefined, "GET", ["wall"])).resolves.toBeDefined();
        await expect(owned("GET", ["board"])).resolves.toBeDefined();
      }
      await expect(code("erin")).rejects.toMatchObject({ status: 403 });
      await manageMembership(owner, "PATCH", {
        id: member.memberId,
        status: "approved",
      });
      await expect(
        as(member.accessToken, "GET", ["board"]),
      ).resolves.toBeDefined();
      await expect(
        executeCall({
          site: "alice",
          method: "POST",
          path: ["membership:ping"],
          bearer,
        }),
      ).resolves.toEqual({ result: true, written: [] });
      const issued = await code("erin");
      await manageMembership(owner, "PATCH", {
        id: member.memberId,
        status: "banned",
      });
      await expect(exchange(issued)).rejects.toMatchObject({ status: 403 });
      await expect(
        previewMemberSignIn(users.erin, input()),
      ).rejects.toMatchObject({ status: 403 });
      // Another site cannot manage this member; malformed controls cannot write.
      await expect(
        manageMembership(users.bob, "PATCH", {
          id: member.memberId,
          status: "approved",
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        manageMembership(owner, "PATCH", {
          id: member.memberId,
          status: "invented",
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        manageMembership(owner, "PATCH", { admission: "invented" }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await manageMembership(owner, "PATCH", {
        id: member.memberId,
        status: "approved",
      });
    }
  });

  test("admission determines new members only and closed sites allow existing members", async () => {
    users.frank = await insertUser("frank");
    users.grace = await insertUser("grace");
    for (const login of ["frank", "grace"])
      await sql`insert into sessions values (${`${login}-session`}, ${users[login]}, now() + interval '60 days')`.execute(
        db,
      );
    try {
      await manageMembership(owner, "PATCH", { admission: "closed" });
      await expect(code("frank")).rejects.toMatchObject({ status: 403 });
      await expect(
        previewMemberSignIn(users.frank, input()),
      ).rejects.toMatchObject({ status: 403 });
      await expect(signIn("bob")).resolves.toBeDefined();
      await manageMembership(owner, "PATCH", { admission: "approval" });
      const frank = await signIn("frank");
      await expect(
        as(frank.accessToken, "GET", ["board"]),
      ).rejects.toMatchObject({ status: 403 });
      await manageMembership(owner, "PATCH", { admission: "open" });
      expect((await manageMembership(owner, "GET")).members).toContainEqual(
        expect.objectContaining({ id: frank.memberId, status: "pending" }),
      );
      const grace = await signIn("grace");
      await expect(
        as(grace.accessToken, "GET", ["board"]),
      ).resolves.toBeDefined();
      await manageMembership(owner, "PATCH", {
        id: frank.memberId,
        status: "approved",
      });
      await expect(
        as(frank.accessToken, "GET", ["board"]),
      ).resolves.toBeDefined();
      const list = await manageMembership(owner, "GET");
      expect(list.admission).toBe("open");
      expect(
        list.members!.every(
          (m) => Object.keys(m).sort().join(",") === "createdAt,id,status",
        ),
      ).toBe(true);
    } finally {
      await manageMembership(owner, "PATCH", { admission: "open" });
    }
  });

  test("a site can require a verified email to sign in as a member", async () => {
    users.hana = await insertUser("hana");
    await sql`insert into sessions values ('hana-session', ${users.hana}, now() + interval '60 days')`.execute(
      db,
    );
    const bob = await signIn("bob");
    try {
      expect((await manageMembership(owner, "GET")).verifiedEmail).toBe(false);
      await manageMembership(owner, "PATCH", { verifiedEmail: true });
      expect((await manageMembership(owner, "GET")).verifiedEmail).toBe(true);
      // Unverified: the sign-in page says so, and approval is refused.
      expect(await previewMemberSignIn(users.hana, input())).toMatchObject({
        needsVerifiedEmail: true,
      });
      await expect(code("hana")).rejects.toMatchObject({
        status: 403,
        code: "ACCESS_DENIED",
      });
      // Returning members are checked at sign-in too; issued tokens still work.
      await expect(code("bob")).rejects.toMatchObject({ status: 403 });
      await expect(
        as(bob.accessToken, "GET", ["board"]),
      ).resolves.toBeDefined();
      // An email pending verification is not enough; a verified one is.
      await sql`update users set email = 'hana@example.com' where id = ${users.hana}`.execute(
        db,
      );
      await expect(code("hana")).rejects.toMatchObject({ status: 403 });
      await sql`update users set email_verified_at = now() where id = ${users.hana}`.execute(
        db,
      );
      expect(await previewMemberSignIn(users.hana, input())).toMatchObject({
        needsVerifiedEmail: false,
      });
      await expect(signIn("hana")).resolves.toHaveProperty("accessToken");
      await expect(
        manageMembership(owner, "PATCH", { verifiedEmail: "yes" }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await manageMembership(owner, "PATCH", { verifiedEmail: false });
    }
  });

  test("member collections: members add, and replace and delete their own", async () => {
    const bob = await signIn("bob");
    const carol = await signIn("carol");
    // Visitors neither read nor write them.
    await expect(as(undefined, "GET", ["board"])).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      as(undefined, "POST", ["board"], { data: "x" }),
    ).rejects.toMatchObject({ status: 403 });
    const post = await as(bob.accessToken, "POST", ["board"], {
      data: { title: "hi" },
    });
    expect(post).toMatchObject({ createdBy: bob.memberId, version: 1 });
    expect(
      await as(carol.accessToken, "GET", ["board", post.id]),
    ).toMatchObject({ document: { createdBy: bob.memberId } });
    const listed = await as(carol.accessToken, "GET", ["board"]);
    expect(listed.documents[0]).toMatchObject({ createdBy: bob.memberId });
    // Its author replaces it, keeping who and when; no one else does.
    const replaced = await as(bob.accessToken, "PUT", ["board", post.id], {
      data: { title: "edited" },
    });
    expect(replaced).toMatchObject({
      createdBy: bob.memberId,
      version: 2,
      createdAt: post.createdAt,
    });
    await expect(
      as(carol.accessToken, "PUT", ["board", post.id], { data: "mine" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as(carol.accessToken, "DELETE", ["board", post.id]),
    ).rejects.toMatchObject({ status: 403 });
    // A chosen id is only ever the member's own.
    await expect(
      as(carol.accessToken, "PUT", ["board", "anything"], { data: 1 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as(carol.accessToken, "PUT", ["board", bob.memberId], { data: 1 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await as(carol.accessToken, "PUT", ["board", carol.memberId], {
        data: { nick: "carol" },
      }),
    ).toMatchObject({ id: carol.memberId, createdBy: carol.memberId });
    // The owner may change anything, and the author stays the author.
    expect(
      await owned("PUT", ["board", post.id], { data: { title: "moderated" } }),
    ).toMatchObject({ createdBy: bob.memberId });
    // The owner's own documents have no member author, and are the owner's.
    const notice = await owned("PUT", ["board", "notice"], { data: "rules" });
    expect(notice.createdBy).toBeNull();
    await expect(
      as(bob.accessToken, "PUT", ["board", "notice"], { data: "mine" }),
    ).rejects.toMatchObject({ status: 403 });
    // Deleting: the author's, and a missing document is already gone.
    await as(bob.accessToken, "DELETE", ["board", post.id]);
    await as(bob.accessToken, "DELETE", ["board", post.id]);
    await expect(
      as(bob.accessToken, "GET", ["board", post.id]),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("members are visitors elsewhere, and their writes still name them", async () => {
    const bob = await signIn("bob");
    const signed = await as(bob.accessToken, "POST", ["guestbook"], {
      data: "hello",
    });
    expect(signed.createdBy).toBe(bob.memberId);
    await expect(
      as(bob.accessToken, "PUT", ["guestbook", signed.id], { data: "x" }),
    ).rejects.toMatchObject({ status: 403 });
    const anonymous = await as(undefined, "POST", ["guestbook"], {
      data: "hi",
    });
    expect(anonymous.createdBy).toBeNull();
    expect(
      await as(bob.accessToken, "PUT", ["wall", "w"], { data: 1 }),
    ).toMatchObject({ createdBy: bob.memberId });
    expect(
      await as(undefined, "PUT", ["wall", "w"], { data: 2 }),
    ).toMatchObject({ createdBy: bob.memberId });
    await expect(as(bob.accessToken, "GET", ["notes"])).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      as(bob.accessToken, "POST", ["notes"], { data: 1 }),
    ).rejects.toMatchObject({ status: 403 });
    // World-read, member-write: anyone reads, members write.
    await as(bob.accessToken, "POST", ["public"], { data: "announcement" });
    await expect(as(undefined, "GET", ["public"])).resolves.toMatchObject({
      documents: [expect.objectContaining({ createdBy: bob.memberId })],
    });
    // Nothing of the owner's: collections and batches.
    await expect(
      as(bob.accessToken, "POST", [], { name: "mine" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(as(bob.accessToken, "GET", [])).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      as(bob.accessToken, "PATCH", ["board"], {
        read: "world",
        write: "world",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      executeBatch({
        site: "alice",
        path: [],
        method: "POST",
        bearer: { token: bob.accessToken, origin },
        body: {
          operations: [{ type: "delete", collection: "board", id: "x" }],
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("a member's writes are limited per minute; the owner's are not", async () => {
    await owned("POST", [], { name: "flood", read: "member", write: "member" });
    const dave = await signIn("dave");
    const results = [];
    for (let n = 0; n < 31; n += 1)
      results.push(
        await as(dave.accessToken, "POST", ["flood"], { data: n }).then(
          () => 201,
          (error) => error.status,
        ),
      );
    // A minute boundary can fall inside the loop, which then passes all 31.
    if (results.at(-1) !== 201) {
      expect(results.slice(0, 30)).toEqual(Array(30).fill(201));
      expect(results.at(-1)).toBe(429);
    }
    await expect(
      owned("POST", ["flood"], { data: "owner" }),
    ).resolves.toBeDefined();
  });

  test("members count against the site's monthly budget, like visitors", async () => {
    const bob = await signIn("bob");
    const snapshot = await callSiteObject("alice", "export", {});
    try {
      await callSiteObject("alice", "import", snapshot);
      await callSiteObject("alice", "configure", {
        ownerId: String(owner),
        entitledUntil: null,
        confirmedUntil: Date.now() + 60_000,
        monthlyRequests: 2,
      });
      await as(bob.accessToken, "GET", ["board"]);
      await as(undefined, "GET", ["wall"]);
      await expect(as(bob.accessToken, "GET", ["board"])).rejects.toMatchObject(
        { status: 429, code: "RATE_LIMITED" },
      );
      await expect(owned("GET", ["board"])).resolves.toBeDefined();
    } finally {
      await callSiteObject("alice", "import", snapshot);
      await callSiteObject("alice", "configure", {
        ownerId: String(owner),
        entitledUntil: null,
        confirmedUntil: Date.now() + 60_000,
        monthlyRequests: null,
      });
    }
  });

  test("documents from before members have no author", async () => {
    // A snapshot from before members has no created_by; importing keeps the
    // documents and gives them no author.
    await callSiteObject("alice", "import", {
      ownerId: String(owner),
      collections: [
        { id: "c1", name: "old", read_access: "world", write_access: "admin" },
      ],
      documents: [
        {
          collection_id: "c1",
          id: "kept",
          data: '"before"',
          size_bytes: 8,
          version: 1,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ],
    });
    expect(await as(undefined, "GET", ["old", "kept"])).toMatchObject({
      document: { data: "before", createdBy: null },
    });
    await eraseSiteData("alice");
    for (const [name, read, write] of [
      ["board", "member", "member"],
      ["guestbook", "world", "create"],
      ["wall", "world", "world"],
      ["notes", "admin", "admin"],
      ["public", "world", "member"],
    ])
      await owned("POST", [], { name, read, write });
  });

  test("native collection rules enforce board levels, secrets, moderation and fail closed", async () => {
    const bob = await signIn("bob");
    const carol = await signIn("carol");
    await owned("POST", [], {
      name: "rule_posts",
      read: "member",
      write: "member",
    });
    await owned("POST", [], {
      name: "rule_roles",
      read: "admin",
      write: "admin",
    });
    await owned("PUT", ["rule_roles", bob.memberId], { data: { level: 2 } });
    await owned("PUT", ["rule_roles", carol.memberId], {
      data: { level: 10, moderator: true },
    });
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      file: "board",
      folder: "rules",
      source: `
      export async function readable(ctx) {
        if (!ctx.member) return false;
        const role = (await ctx.get("rule_roles", ctx.member.id))?.data;
        if (!role || role.level < 2) return false;
        return role.moderator ? true : { any: [{ ne: ["secret", true] }, { eq: ["owner", ctx.member.id] }] };
      }
      export async function canWrite(ctx, {before, after, operation}) {
        const role = (await ctx.get("rule_roles", ctx.member.id))?.data;
        if (!role || role.level < 2) return false;
        if (operation === "create") return after.data.owner === ctx.member.id;
        return (role.moderator || before.data.owner === ctx.member.id) && (!after || after.data.owner === before.data.owner);
      }
    `,
    });
    await owned("PATCH", ["rule_posts"], {
      read: "member",
      write: "member",
      rules: "board",
    });
    await owned("PUT", ["rule_posts", "a"], {
      data: { owner: carol.memberId, secret: true, text: "private" },
    });
    for (const id of ["b", "c", "d"])
      await owned("PUT", ["rule_posts", id], {
        data: { owner: carol.memberId, text: id },
      });
    const page = await as(bob.accessToken, "GET", ["rule_posts"], undefined, {
      size: 2,
      includeTotal: true,
    });
    const bulk = await as(bob.accessToken, "GET", ["rule_posts"], undefined, {
      ids: JSON.stringify(["c", "a", "missing", "c"]),
    });
    expect(bulk.documents.map((row: any) => row?.id ?? null)).toEqual([
      "c",
      null,
      null,
      "c",
    ]);
    await expect(
      as(bob.accessToken, "GET", ["rule_posts"], undefined, {
        ids: JSON.stringify(Array(101).fill("c")),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(page.totalCount).toBe(3);
    expect(page.documents.map((d: any) => d.id)).toEqual(["b", "c"]);
    expect(
      (
        await as(bob.accessToken, "GET", ["rule_posts"], undefined, {
          size: 2,
          after: page.nextCursor,
        })
      ).documents.map((d: any) => d.id),
    ).toEqual(["d"]);
    await expect(
      as(bob.accessToken, "GET", ["rule_posts", "a"]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      as(bob.accessToken, "PUT", ["rule_posts", "b"], {
        data: { owner: carol.memberId },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as(bob.accessToken, "POST", ["rule_posts"], {
        data: { owner: carol.memberId },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      as(bob.accessToken, "POST", ["rule_posts"], {
        data: { owner: bob.memberId, secret: true },
      }),
    ).resolves.toMatchObject({ createdBy: bob.memberId });
    await expect(
      as(carol.accessToken, "GET", ["rule_posts", "a"]),
    ).resolves.toBeDefined();
    await as(carol.accessToken, "PUT", ["rule_posts", "b"], {
      data: { owner: carol.memberId, text: "moderated" },
    });
    await owned("PATCH", ["rule_posts"], {
      read: "world",
      write: "member",
      rules: "board",
    });
    await callSiteObject("alice", "configure", {
      ownerId: String(owner),
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
    });
    const anonymous = await fetch(
      `${process.env.EDGE_WORKER_URL}/api/data/v1/alice/rule_posts?includeTotal=1`,
    );
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    expect(await anonymous.json()).toMatchObject({
      documents: [],
      totalCount: 0,
    });
    const snapshot = await callSiteObject<any>("alice", "export", {});
    expect(Object.values(snapshot.rules)).toContain("board");
    await callSiteObject("alice", "import", snapshot);
    await expect(
      as(bob.accessToken, "GET", ["rule_posts", "a"]),
    ).rejects.toMatchObject({ status: 404 });
    // Missing files and mutating hooks deny access, never falling back to collection permissions.
    await owned("PATCH", ["rule_posts"], {
      read: "member",
      write: "member",
      rules: "missing",
    });
    await expect(
      as(bob.accessToken, "GET", ["rule_posts"]),
    ).rejects.toMatchObject({ status: 403 });
    await expect(owned("GET", ["rule_posts"])).resolves.toBeDefined();
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      file: "mutating",
      folder: "rules",
      source:
        'export async function readable(ctx) { await ctx.set("rule_roles", "bad", {}); return true; }',
    });
    await owned("PATCH", ["rule_posts"], {
      read: "member",
      write: "member",
      rules: "mutating",
    });
    await expect(
      as(bob.accessToken, "GET", ["rule_posts"]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(owned("GET", ["rule_roles", "bad"])).rejects.toMatchObject({
      status: 404,
    });
    await owned("DELETE", ["rule_posts"]);
    await owned("DELETE", ["rule_roles"]);
  });

  test("a collection's indexed fields are kept, listed, changed and dropped", async () => {
    await owned("POST", [], { name: "indexed", read: "admin", write: "admin" });
    try {
      for (const [id, board] of [
        ["a", "free"],
        ["b", "notice"],
        ["c", "free"],
      ])
        await owned("PUT", ["indexed", id], { data: { board } });
      const settings = () =>
        listCollections({ id: owner, loginName: "alice" }, ["indexed"]);
      await owned("PATCH", ["indexed"], {
        read: "admin",
        write: "admin",
        indexes: ["board", "owner"],
      });
      expect(await settings()).toMatchObject([
        { name: "indexed", indexes: ["board", "owner"] },
      ]);
      // Reads find the same documents through it.
      const page = (await owned("GET", ["indexed"], undefined)) as any;
      expect(page.documents).toHaveLength(3);
      expect(
        (
          (await executeData({
            site: "alice",
            path: ["indexed"],
            method: "GET",
            adminUserId: owner,
            filter: { board: "free" },
          })) as any
        ).documents.map((d: any) => d.id),
      ).toEqual(["a", "c"]);
      // A snapshot carries them, and a copy rebuilds them.
      const snapshot = await callSiteObject<any>("alice", "export", {});
      expect(Object.values(snapshot.indexes)).toContainEqual([
        "board",
        "owner",
      ]);
      await owned("PATCH", ["indexed"], {
        read: "admin",
        write: "admin",
        indexes: ["owner", "a", "b", "c", "d", "e"],
      }).then(
        () => {
          throw new Error("six indexes were accepted");
        },
        (error) => expect(error).toMatchObject({ status: 400 }),
      );
      await owned("PATCH", ["indexed"], {
        read: "admin",
        write: "admin",
        indexes: [],
      });
      expect((await settings())[0]).not.toHaveProperty("indexes");
    } finally {
      await owned("DELETE", ["indexed"]);
    }
  });

  test("a rule's refusals and mistakes name the rule, and ctx.fail speaks for it", async () => {
    const reader = await signIn("dave");
    await owned("POST", [], { name: "told", read: "member", write: "member" });
    await owned("PUT", ["told", "one"], { data: { text: "a" } });
    const rule = async (source: string) => {
      await callSiteObject("alice", "putFunctions", {
        site: "alice",
        folder: "rules",
        file: "told",
        source,
      });
      await owned("PATCH", ["told"], {
        read: "member",
        write: "member",
        rules: "told",
      });
    };
    const write = () =>
      as(reader.accessToken, "PUT", ["told", "one"], { data: { text: "b" } });
    const read = () => as(reader.accessToken, "GET", ["told"]);

    // Forgetting to return true is the usual mistake: the refusal says so.
    await rule(`export function readable() { return true; }
      export function canWrite() {}`);
    await expect(write()).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(
        /_naru\/rules\/told\.js refused this \w+ on told: canWrite returned undefined\. .*returns true/,
      ),
    });
    await rule(`export function readable() { return true; }`);
    await expect(write()).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("no canWrite function"),
    });
    // ctx.fail in a rule is the site's own word, as in a function.
    await rule(`export function readable() { return true; }
      export function canWrite(ctx) { ctx.fail("ACCESS_DENIED", "운영진만 고칠 수 있습니다."); }`);
    await expect(write()).rejects.toMatchObject({
      status: 403,
      message: "운영진만 고칠 수 있습니다.",
      site: true,
    });
    await rule(
      `export function readable(ctx) { ctx.fail("AUTH_REQUIRED", "회원만 볼 수 있는 게시판입니다."); }`,
    );
    await expect(read()).rejects.toMatchObject({
      status: 401,
      message: "회원만 볼 수 있는 게시판입니다.",
      site: true,
    });
    await rule(`export function readable() { return { eq: "board" }; }`);
    await expect(read()).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining(
        "Collection rule _naru/rules/told.js readable() for told returned an invalid predicate",
      ),
    });
    await rule(`export function readable() { throw new Error("no board"); }`);
    await expect(read()).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(
        /Collection rule _naru\/rules\/told\.js failed in readable\(\) for told: .*no board/,
      ),
    });
    await rule(`export const nothing = 1;`);
    await expect(read()).rejects.toMatchObject({
      message: expect.stringContaining("exports no readable function"),
    });
    await owned("PATCH", ["told"], {
      read: "member",
      write: "member",
      rules: "unpublished",
    });
    await expect(read()).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining(
        "Collection told uses _naru/rules/unpublished.js, which the site's published files do not have",
      ),
    });
    await owned("DELETE", ["told"]);
  });

  test("a collection rule imports shared modules from the same revision", async () => {
    const bob = await signIn("dave");
    await owned("POST", [], { name: "gated", read: "member", write: "member" });
    await owned("PUT", ["gated", "open"], { data: { level: 1 } });
    await owned("PUT", ["gated", "closed"], { data: { level: 9 } });
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      folder: "modules",
      file: "levels",
      source: "export const visible = 5;",
    });
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      folder: "rules",
      file: "gated",
      source: `import { visible } from "../modules/levels.js";
        export function readable() { return { lte: ["level", visible] }; }
        export function canWrite() { return false; }`,
    });
    await owned("PATCH", ["gated"], {
      read: "member",
      write: "member",
      rules: "gated",
    });
    const page = (await as(bob.accessToken, "GET", ["gated"])) as any;
    expect(page.documents.map((d: any) => d.id)).toEqual(["open"]);
    // Shared code changes reach the rule when the revision is published.
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      folder: "modules",
      file: "levels",
      source: "export const visible = 10;",
    });
    expect(
      ((await as(bob.accessToken, "GET", ["gated"])) as any).documents.length,
    ).toBe(2);
    await owned("DELETE", ["gated"]);
  });

  test("a rule's present trims what non-owners read, and limits their queries", async () => {
    const reader = await signIn("dave");
    await owned("POST", [], { name: "sheets", read: "member", write: "admin" });
    await owned("PUT", ["sheets", "a"], {
      data: { name: "A", side: "east", note: "owner only", tags: ["x"] },
    });
    await owned("PUT", ["sheets", "b"], {
      data: { name: "B", side: "west", note: "hidden too", tags: ["y"] },
    });
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      folder: "rules",
      file: "sheets",
      source: `export const queryable = ["name", "side", "tags"];
        export function readable() { return true; }
        export function canWrite() { return false; }
        export function present(ctx, { document }) {
          const { note, ...shown } = document.data;
          return shown;
        }`,
    });
    await owned("PATCH", ["sheets"], {
      read: "member",
      write: "admin",
      rules: "sheets",
    });
    try {
      const page = (await as(reader.accessToken, "GET", ["sheets"])) as any;
      expect(page.documents.map((d: any) => d.data)).toEqual([
        { name: "A", side: "east", tags: ["x"] },
        { name: "B", side: "west", tags: ["y"] },
      ]);
      expect(
        ((await as(reader.accessToken, "GET", ["sheets", "a"])) as any).document
          .data.note,
      ).toBeUndefined();
      const many = (await as(reader.accessToken, "GET", ["sheets"], undefined, {
        ids: JSON.stringify(["b", "missing"]),
      })) as any;
      expect(many.documents).toEqual([
        expect.objectContaining({
          data: { name: "B", side: "west", tags: ["y"] },
        }),
        null,
      ]);
      // Queries on queryable fields work; on hidden ones they are refused.
      expect(
        (
          (await as(reader.accessToken, "GET", ["sheets"], undefined, {
            where: { has: ["tags", "y"] },
          })) as any
        ).documents.map((d: any) => d.id),
      ).toEqual(["b"]);
      for (const extra of [
        { filter: { note: "owner only" } },
        { where: { any: [{ eq: ["note", "owner only"] }] } },
        { sort: JSON.stringify([["note", "asc"]]) },
      ])
        await expect(
          as(reader.accessToken, "GET", ["sheets"], undefined, extra),
        ).rejects.toMatchObject({ status: 400 });
      // The owner reads and queries everything.
      expect(
        ((await owned("GET", ["sheets", "a"])) as any).document.data.note,
      ).toBe("owner only");
    } finally {
      await owned("DELETE", ["sheets"]);
    }
  });

  test("a guest edits and deletes a document with the secret it was added with", async () => {
    await owned("POST", [], { name: "guests", read: "world", write: "create" });
    try {
      const added = (await as(undefined, "POST", ["guests"], {
        data: { name: "길손", text: "hi" },
        secret: "pass1234",
      })) as any;
      // The hash never comes back, to the writer or to anyone else.
      expect(JSON.stringify(added)).not.toMatch(/pbkdf2|pass1234/);
      const read = (await as(undefined, "GET", ["guests", added.id])) as any;
      expect(JSON.stringify(read)).not.toMatch(/pbkdf2|secret/);
      // Without the secret, or with a wrong one, a visitor cannot change it.
      for (const secret of [undefined, "wrong"])
        await expect(
          as(undefined, "PUT", ["guests", added.id], {
            data: { name: "x" },
            ...(secret ? { secret } : {}),
          }),
        ).rejects.toMatchObject({ status: 403 });
      const edited = (await as(undefined, "PUT", ["guests", added.id], {
        data: { name: "길손", text: "edited" },
        secret: "pass1234",
      })) as any;
      expect(edited.data.text).toBe("edited");
      // A document added without a secret stays the owner's to change.
      const plain = (await as(undefined, "POST", ["guests"], {
        data: { text: "plain" },
      })) as any;
      await expect(
        as(undefined, "DELETE", ["guests", plain.id], { secret: "pass1234" }),
      ).rejects.toMatchObject({ status: 403 });
      await as(undefined, "DELETE", ["guests", added.id], {
        secret: "pass1234",
      });
      await expect(
        as(undefined, "GET", ["guests", added.id]),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        as(undefined, "POST", ["guests"], { data: {}, secret: "" }),
      ).rejects.toMatchObject({ status: 400 });
      // A rule sees whether the secret matched, and decides.
      await callSiteObject("alice", "putFunctions", {
        site: "alice",
        folder: "rules",
        file: "guests",
        source: `export function readable() { return true; }
          export function canWrite(ctx, { before, after, secret }) {
            if (!before) return typeof after.data.name === "string";
            return secret === true && (!after || after.data.name === before.data.name);
          }`,
      });
      await owned("PATCH", ["guests"], {
        read: "world",
        write: "create",
        rules: "guests",
      });
      const ruled = (await as(undefined, "POST", ["guests"], {
        data: { name: "손님", text: "a" },
        secret: "s3cret",
      })) as any;
      await expect(
        as(undefined, "PUT", ["guests", ruled.id], {
          data: { name: "바꿈", text: "b" },
          secret: "s3cret",
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        as(undefined, "PUT", ["guests", ruled.id], {
          data: { name: "손님", text: "b" },
          secret: "s3cret",
        }),
      ).resolves.toBeDefined();
    } finally {
      await owned("DELETE", ["guests"]);
    }
  });

  test("functions store and check a document's secret, shared with native writes", async () => {
    await owned("POST", [], {
      name: "secret_book",
      read: "world",
      write: "create",
    });
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      file: "secretbook",
      source: `export const visitors = ["post", "check"];
        export async function post(ctx, { text, secret }) {
          return (await ctx.add("secret_book", { text }, { secret })).id;
        }
        export async function check(ctx, { id, secret }) {
          return await ctx.secretMatches("secret_book", id, secret);
        }`,
    });
    try {
      const call = (name: string, args: unknown) =>
        callSiteObject<any>("alice", "call", {
          ownerId: String(owner),
          site: "alice",
          member: null,
          visitor: true,
          file: "secretbook",
          name,
          args,
        });
      const { result: id } = await call("post", {
        text: "hi",
        secret: "s3cret",
      });
      expect((await call("check", { id, secret: "s3cret" })).result).toBe(true);
      expect((await call("check", { id, secret: "wrong" })).result).toBe(false);
      // A visitor edits natively with the secret the function stored.
      await expect(
        as(undefined, "PUT", ["secret_book", id], {
          data: { text: "edited" },
          secret: "s3cret",
        }),
      ).resolves.toBeDefined();
      const read = (await as(undefined, "GET", ["secret_book", id])) as any;
      expect(JSON.stringify(read)).not.toMatch(/pbkdf2/);
    } finally {
      await owned("DELETE", ["secret_book"]);
    }
  });

  test("visitors call only the exports a module opens to them, by address", async () => {
    await owned("POST", [], {
      name: "visitor_book",
      read: "admin",
      write: "admin",
    });
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      file: "guest",
      source: `export const visitors = ["post", "edit", "list"];
        export const readOnly = ["list"];
        export async function post(ctx, { name, text, password }) {
          const doc = await ctx.add("visitor_book", { name, text }, { secret: password });
          ctx.broadcast("visitor_book", { id: doc.id });
          return doc.id;
        }
        export async function edit(ctx, { id, text, password }) {
          const doc = await ctx.get("visitor_book", id);
          if (!doc || !(await ctx.secretMatches("visitor_book", id, password)))
            ctx.fail("ACCESS_DENIED", "비밀번호가 맞지 않습니다.", { reason: "wrong_password" });
          await ctx.set("visitor_book", id, { ...doc.data, text }, { condition: { revision: doc.revision } });
          return true;
        }
        export async function list(ctx) {
          const page = await ctx.list("visitor_book");
          return page.documents.map((d) => ({ name: d.data.name, text: d.data.text, visitor: ctx.visitor }));
        }
        export function membersOnly(ctx) { return ctx.member?.id ?? null; }`,
    });
    const visit = (name: string, args: unknown, clientIp = "203.0.113.7") =>
      executeCall({
        site: "alice",
        path: [name],
        method: "POST",
        body: { args },
        clientIp,
      }) as Promise<{ result: any; written: string[] }>;
    const id = (
      await visit("guest:post", {
        name: "손님",
        text: "안녕",
        password: "1234",
      })
    ).result;
    await expect(
      visit("guest:edit", { id, text: "바꿈", password: "0000" }),
    ).rejects.toMatchObject({
      status: 403,
      details: { reason: "wrong_password" },
    });
    expect(
      (await visit("guest:edit", { id, text: "바꿈", password: "1234" }))
        .written,
    ).toEqual(["visitor_book"]);
    // The function decides what visitors see: never the stored hash.
    expect((await visit("guest:list", null)).result).toEqual([
      { name: "손님", text: "바꿈", visitor: true },
    ]);
    // Exports not opened to visitors still need a sign-in.
    await expect(visit("guest:membersOnly", null)).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    // Calls that may write: 20 a minute per address (two made above, one refused).
    for (let n = 0; n < 18; n++)
      await visit("guest:membersOnly", null, "203.0.113.9").catch(() => null);
    const results: number[] = [];
    for (let n = 0; n < 20; n++)
      results.push(
        await visit(
          "guest:edit",
          { id, text: "x", password: "1234" },
          "198.51.100.1",
        ).then(
          () => 200,
          (error) => error.status,
        ),
      );
    expect(results).toEqual(Array(20).fill(200));
    await expect(
      visit("guest:edit", { id, text: "x", password: "1234" }, "198.51.100.1"),
    ).rejects.toMatchObject({ status: 429 });
    // Another address still may, and reads have their own budget.
    await visit(
      "guest:edit",
      { id, text: "ok", password: "1234" },
      "198.51.100.2",
    );
    await visit("guest:list", null, "198.51.100.1");
    // At the edge, as browsers reach it: answered by the site's object.
    await callSiteObject("alice", "configure", {
      ownerId: String(owner),
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
    });
    const atEdge = await fetch(
      `${process.env.EDGE_WORKER_URL}/api/data/v1/alice/_call/guest:post`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          args: { name: "엣지", text: "hi", password: "pass" },
        }),
      },
    );
    expect(atEdge.status).toBe(200);
    expect(await atEdge.json()).toMatchObject({ written: ["visitor_book"] });
    const refused = await fetch(
      `${process.env.EDGE_WORKER_URL}/api/data/v1/alice/_call/guest:membersOnly`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(refused.status).toBe(401);
    await owned("DELETE", ["visitor_book"]);
  });

  test("unique fields refuse a second document with the same value, on every write path", async () => {
    const bob = await signIn("dave");
    const carol = await signIn("read-budget");
    await owned("POST", [], { name: "nicks", read: "member", write: "member" });
    await as(bob.accessToken, "PUT", ["nicks", bob.memberId], {
      data: { nick: "lime" },
    });
    await as(carol.accessToken, "PUT", ["nicks", carol.memberId], {
      data: { nick: "lime" },
    });
    // Existing duplicates refuse the setting.
    await expect(
      owned("PATCH", ["nicks"], {
        read: "member",
        write: "member",
        unique: ["nick"],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await as(carol.accessToken, "PUT", ["nicks", carol.memberId], {
      data: { nick: "lemon" },
    });
    await owned("PATCH", ["nicks"], {
      read: "member",
      write: "member",
      unique: ["nick"],
    });
    expect(
      ((await owned("GET", [])) as any).collections.find(
        (c: any) => c.name === "nicks",
      ),
    ).toMatchObject({ unique: ["nick"] });
    await expect(
      as(carol.accessToken, "PUT", ["nicks", carol.memberId], {
        data: { nick: "lime" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      details: { unique: "nick" },
    });
    // Rewriting your own document keeps your own value.
    await as(bob.accessToken, "PUT", ["nicks", bob.memberId], {
      data: { nick: "lime", bio: "hi" },
    });
    // A number is not the same value as a string.
    await as(carol.accessToken, "PUT", ["nicks", carol.memberId], {
      data: { nick: 7 },
    });
    await expect(
      executeBatch({
        site: "alice",
        adminUserId: owner,
        method: "POST",
        path: [],
        body: {
          operations: [
            {
              type: "set",
              collection: "nicks",
              id: "x",
              data: { nick: "lime" },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await owned("PATCH", ["nicks"], {
      read: "member",
      write: "member",
      unique: null,
    });
    await owned("PUT", ["nicks", "x"], { data: { nick: "lime" } });
    await owned("DELETE", ["nicks"]);
  });

  test("live connections hear what functions send, after they commit, until access ends", async () => {
    const WebSocketClient = (globalThis as { WebSocket?: typeof WebSocket })
      .WebSocket;
    if (!WebSocketClient) return;
    const bob = await signIn("fern");
    await callSiteObject("alice", "configure", {
      ownerId: String(owner),
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
    });
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      file: "live",
      source: `export function send(ctx, { to, fail }) {
        ctx.notify(to, { unread: 1 });
        ctx.broadcast("board", { post: "new" });
        if (fail) throw new Error("rolled back");
        return true;
      }`,
    });
    const base = `${process.env.EDGE_WORKER_URL!.replace(/^http/, "ws")}/api/data/v1/alice/_live`;
    const open = (query: string) =>
      new Promise<{
        socket: WebSocket;
        heard: unknown[];
        closed: Promise<number>;
      }>((resolve, reject) => {
        const socket = new WebSocketClient(`${base}?${query}`);
        const heard: unknown[] = [];
        const closed = new Promise<number>((done) =>
          socket.addEventListener("close", (event) => done(event.code)),
        );
        socket.addEventListener("message", (event) =>
          heard.push(JSON.parse(String(event.data))),
        );
        socket.addEventListener("open", () =>
          resolve({ socket, heard, closed }),
        );
        socket.addEventListener("error", () => reject(new Error("refused")));
      });
    const { ticket } = (await executeLiveTicket({
      site: "alice",
      path: ["_live"],
      method: "POST",
      bearer: { token: bob.accessToken, origin },
    })) as { ticket: string };
    const member = await open(`ticket=${ticket}`);
    const visitor = await open("topics=board");
    await expect(
      open("ticket=forged.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).rejects.toThrow();
    // Visitors get no ticket: they listen without one.
    await expect(
      executeLiveTicket({ site: "alice", path: ["_live"], method: "POST" }),
    ).rejects.toMatchObject({ status: 401 });
    const call = (args: unknown) =>
      executeCall({
        site: "alice",
        path: ["live:send"],
        method: "POST",
        body: { args },
        bearer: { token: bob.accessToken, origin },
      });
    await expect(call({ to: bob.memberId, fail: true })).rejects.toMatchObject({
      status: 400,
    });
    await call({ to: bob.memberId });
    const settle = () => new Promise((done) => setTimeout(done, 300));
    await settle();
    // Only the committed call's messages arrive.
    expect(member.heard).toEqual([{ type: "notice", data: { unread: 1 } }]);
    expect(visitor.heard).toEqual([
      { type: "topic", topic: "board", data: { post: "new" } },
    ]);
    await manageMembership(owner, "PATCH", {
      id: bob.memberId,
      status: "banned",
    });
    expect(await member.closed).toBe(4003);
    await manageMembership(owner, "PATCH", {
      id: bob.memberId,
      status: "approved",
    });
    visitor.socket.close();
    await visitor.closed;
  }, 20000);

  describe("uploads", () => {
    const media = (token: string, method: string, path: string[], body = {}) =>
      executeMedia({
        site: "alice",
        path,
        method,
        body,
        bearer: { token, origin },
      }) as Promise<Record<string, any>>;
    beforeAll(() => {
      jest
        .spyOn(mediaDeletionStorage, "deleteObject")
        .mockImplementation(async () => ({ $metadata: {} }));
      jest
        .spyOn(mediaStorage, "authorizeUpload")
        .mockImplementation(async (key) => `https://upload.invalid/${key}`);
      jest
        .spyOn(mediaStorage, "headObject")
        .mockImplementation(
          async () =>
            ({ ContentLength: 3, ContentType: "image/png" }) as Awaited<
              ReturnType<typeof mediaStorage.headObject>
            >,
        );
    });
    afterAll(() => {
      jest.restoreAllMocks();
    });
    const file = { name: "log.png", contentType: "image/png", size: 3 };

    test("a managed upload lives while documents use it, in any field or HTML", async () => {
      const bob = await signIn("bob");
      const upload = async () => {
        const authorized = await media(bob.accessToken, "POST", [], {
          ...file,
          managed: true,
        });
        return (await media(bob.accessToken, "PUT", [authorized.id])).file;
      };
      const kept = await upload();
      const swapped = await upload();
      const unused = await upload();
      const plain = (
        await media(bob.accessToken, "PUT", [
          (await media(bob.accessToken, "POST", [], file)).id,
        ])
      ).file;
      const released = async () =>
        (await callSiteObject<string[]>("alice", "mediaReleases", {})).sort();
      await owned("POST", [], {
        name: "posts_m",
        read: "world",
        write: "admin",
      });
      try {
        await owned("PUT", ["posts_m", "a"], {
          data: { image: kept.url, body: `<p><img src="${swapped.url}"></p>` },
        });
        await owned("PUT", ["posts_m", "b"], {
          data: { html: `<img src="${kept.url}">`, other: plain.url },
        });
        expect(await released()).toEqual([]);
        // Editing out an upload releases it; another document still keeps one.
        await owned("PUT", ["posts_m", "a"], { data: { image: kept.url } });
        expect(await released()).toEqual([swapped.id]);
        await owned("DELETE", ["posts_m", "a"]);
        expect(await released()).toEqual([swapped.id]);
        await owned("DELETE", ["posts_m", "b"]);
        expect(await released()).toEqual([kept.id, swapped.id].sort());
        // Never used: swept an hour after it was registered.
        await callSiteObject("alice", "sweepMedia", { now: Date.now() });
        expect(await released()).not.toContain(unused.id);
        await callSiteObject("alice", "sweepMedia", {
          now: Date.now() + 61 * 60 * 1000,
        });
        expect(await released()).toContain(unused.id);
        // An unmanaged upload is never released by references.
        expect(await released()).not.toContain(plain.id);
        await runMediaRelease({ site: "alice" }, {
          step: (_name: string, work: () => Promise<unknown>) => work(),
        } as never);
        const rows = await db
          .selectFrom("site_data_files")
          .select(["id", "deleted_at"])
          .where("id", "in", [kept.id, swapped.id, unused.id, plain.id])
          .execute();
        expect(
          Object.fromEntries(
            rows.map((row) => [row.id, Boolean(row.deleted_at)]),
          ),
        ).toEqual({
          [kept.id]: true,
          [swapped.id]: true,
          [unused.id]: true,
          [plain.id]: false,
        });
      } finally {
        await owned("DELETE", ["posts_m"]);
      }
    });

    test("a member uploads into the site's media, and finishes only their own", async () => {
      const bob = await signIn("bob");
      const carol = await signIn("carol");
      const authorized = await media(bob.accessToken, "POST", [], file);
      expect(authorized).toMatchObject({ id: expect.any(String) });
      const row = await db
        .selectFrom("site_data_files")
        .select(["member_id", "user_id"])
        .where("id", "=", authorized.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ member_id: bob.memberId, user_id: owner });
      await expect(
        media(carol.accessToken, "PUT", [authorized.id]),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        await media(bob.accessToken, "PUT", [authorized.id]),
      ).toMatchObject({ file: { name: "log.png", size: 3 } });
      // Members cannot list files or delete another member's upload.
      await expect(media(bob.accessToken, "GET", [])).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        media(carol.accessToken, "DELETE", [authorized.id]),
      ).rejects.toMatchObject({ status: 403 });
      await media(bob.accessToken, "DELETE", [authorized.id]);
      await media(bob.accessToken, "DELETE", [authorized.id]);
      await expect(
        media(bob.accessToken, "PUT", [authorized.id]),
      ).rejects.toMatchObject({ status: 404 });
    });

    test("a function's ctx.media.delete takes effect only if its call commits", async () => {
      const bob = await signIn("bob");
      const upload = async () => {
        const { id } = await media(bob.accessToken, "POST", [], file);
        await media(bob.accessToken, "PUT", [id]);
        return id as string;
      };
      const kept = await upload();
      const released = await upload();
      await callSiteObject("alice", "putFunctions", {
        site: "alice",
        file: "media",
        source: `export async function drop(ctx, { id, fail }) {
          await ctx.media.delete(id);
          if (fail) throw new Error("changed my mind");
          return "queued";
        }`,
      });
      const call = (args: unknown) =>
        executeCall({
          site: "alice",
          path: ["media:drop"],
          method: "POST",
          body: { args },
          bearer: { token: bob.accessToken, origin },
        });
      await expect(call({ id: kept, fail: true })).rejects.toMatchObject({
        status: 400,
      });
      // The queue is the object's own and leaves no trace in the answer.
      expect(await call({ id: released })).toEqual({
        result: "queued",
        written: [],
      });
      expect(await callSiteObject("alice", "mediaReleases", {})).toEqual([
        released,
      ]);
      // Its deletion was handed to the durable queue.
      expect(
        (
          await sql<{
            n: number;
          }>`select count(*)::int as n from absurd.t_maintenance where task_name = 'site-media-release-v1' and params->>'site' = 'alice'`.execute(
            db,
          )
        ).rows[0].n,
      ).toBe(1);
      await runMediaRelease({ site: "alice" }, {
        step: (_name: string, work: () => Promise<unknown>) => work(),
      } as never);
      expect(await callSiteObject("alice", "mediaReleases", {})).toEqual([]);
      const rows = await db
        .selectFrom("site_data_files")
        .select(["id", "deleted_at"])
        .where("id", "in", [kept, released])
        .execute();
      expect(
        Object.fromEntries(
          rows.map((row) => [row.id, Boolean(row.deleted_at)]),
        ),
      ).toEqual({ [kept]: false, [released]: true });
    });

    test("failed deletions remain durable; retries free bytes and stale upload URLs cannot revive finalized media", async () => {
      const bob = await signIn("bob");
      const authorized = await media(bob.accessToken, "POST", [], file);
      const row = await db
        .selectFrom("site_data_files")
        .selectAll()
        .where("id", "=", authorized.id)
        .executeTakeFirstOrThrow();
      const bytes = async () =>
        (
          (await executeMedia({
            site: "alice",
            path: [],
            method: "GET",
            adminUserId: owner,
            usage: true,
          })) as any
        ).usage.bytes;
      const beforeBytes = await bytes();

      jest
        .mocked(mediaDeletionStorage.deleteObject)
        .mockRejectedValueOnce(new Error("storage offline"));
      await expect(
        media(bob.accessToken, "DELETE", [row.id]),
      ).rejects.toMatchObject({ status: 503, code: "UNAVAILABLE" });
      const queued = await db
        .selectFrom("site_data_files")
        .selectAll()
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      expect(queued.deleted_at).not.toBeNull();
      expect(queued.delete_completed_at).toBeNull();
      expect(await bytes()).toBe(beforeBytes);
      await expect(
        media(bob.accessToken, "PUT", [row.id]),
      ).rejects.toMatchObject({ status: 404 });
      await media(bob.accessToken, "DELETE", [row.id]);
      const completed = await db
        .selectFrom("site_data_files")
        .selectAll()
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      expect(completed.delete_completed_at).not.toBeNull();
      expect(await bytes()).toBe(beforeBytes);
      await sql`update site_data_files set upload_expires_at = delete_completed_at + interval '1 millisecond' where id = ${row.id}`.execute(
        db,
      );
      expect(await bytes()).toBe(beforeBytes);
      await cleanupDeletedMedia();
      expect(await bytes()).toBe(beforeBytes - row.size_bytes);
      // Tombstones keep recent upload counts and survive until the upload URL is expired.
      await cleanupDeletedMedia();
      expect(
        await db
          .selectFrom("site_data_files")
          .select("id")
          .where("id", "=", row.id)
          .executeTakeFirst(),
      ).toBeDefined();
      await sql`update site_data_files set deleted_at = now() - interval '61 minutes' where id = ${row.id}`.execute(
        db,
      );
      await cleanupDeletedMedia();
      expect(mediaDeletionStorage.deleteObject).toHaveBeenCalledWith(
        row.object_key,
      );
      expect(
        await db
          .selectFrom("site_data_files")
          .select("id")
          .where("id", "=", row.id)
          .executeTakeFirst(),
      ).toBeUndefined();
      await media(bob.accessToken, "DELETE", [row.id]);
      await expect(
        media(bob.accessToken, "DELETE", ["https://media.invalid/x.png"]),
      ).rejects.toMatchObject({ status: 400 });
    });

    test("a delete racing finalization prevents the finalized response from reviving the file", async () => {
      const bob = await signIn("bob");
      const upload = await media(bob.accessToken, "POST", [], file);
      jest.mocked(mediaStorage.headObject).mockImplementationOnce(async () => {
        await media(bob.accessToken, "DELETE", [upload.id]);
        return { ContentLength: 3, ContentType: "image/png", $metadata: {} };
      });
      await expect(
        media(bob.accessToken, "PUT", [upload.id]),
      ).rejects.toMatchObject({ status: 404 });
    });

    test("a member's uploads are limited per hour", async () => {
      const dave = await signIn("dave");
      for (let n = 0; n < MEMBER_UPLOADS_PER_HOUR; n += 1)
        await db
          .insertInto("site_data_files")
          .values({
            id: crypto.randomUUID(),
            user_id: owner,
            member_id: dave.memberId,
            object_key: `${owner}/limit-${n}`,
            original_name: "x.png",
            content_type: "image/png",
            size_bytes: 1,
          })
          .execute();
      await expect(
        media(dave.accessToken, "POST", [], file),
      ).rejects.toMatchObject({ status: 429 });
      // Others in the site are not held up by it.
      const bob = await signIn("bob");
      await expect(
        media(bob.accessToken, "POST", [], file),
      ).resolves.toBeDefined();
    });
  });

  describe("functions", () => {
    const SHOP = `
      // A shop, as an AvocadoEdition site would have it.
      export const readOnly = ["lookup", "versioned", "mine", "peek", "sneak"];
      export async function buy(ctx, { item }) {
        const listing = await ctx.get("shop", item);
        if (!listing) return { ok: false, reason: "no_such_item" };
        if (listing.data.stock < 1) return { ok: false, reason: "sold_out" };
        const wallet = await ctx.get("wallets", ctx.member.id);
        const balance = wallet ? wallet.data.balance : 0;
        if (balance < listing.data.price) return { ok: false, reason: "not_enough_money" };
        await ctx.set("wallets", ctx.member.id, { balance: balance - listing.data.price });
        await ctx.set("shop", item, { ...listing.data, stock: listing.data.stock - 1 });
        const owned = await ctx.add("inventory", { owner: ctx.member.id, item });
        return { ok: true, balance: balance - listing.data.price, owned };
      }
      export async function buyThenFail(ctx, args) {
        await buy(ctx, args);
        throw new Error("changed my mind");
      }
      export async function buyThenReject(ctx, args) {
        await buy(ctx, args);
        try { ctx.fail("CONFLICT", "Purchase cancelled."); } catch {}
        return { ok: true };
      }
      export async function lookup(ctx) {
        return { rows: await ctx.getMany("shop", ["shield", "missing", "shield"]), empty: await ctx.getMany("shop", []), count: await ctx.count("shop", { filter: { price: 10 } }), zero: await ctx.count("shop", { filter: { price: 999 } }) };
      }
      export async function mine(ctx) {
        return (await ctx.list("inventory", { filter: { owner: ctx.member.id } })).documents.map((d) => d.data.item);
      }
      export function gacha(ctx) {
        return Math.floor(Math.random() * 100);
      }
      export function versioned() {
        return { version: "not a revision", list: [1, { version: 2 }] };
      }
      export function spin() { for (;;) {} }
      export async function flood(ctx) { for (let i = 0; ; i++) await ctx.set("wallets", "x" + i, i); }
      export async function trespass(ctx) { await ctx.get("nowhere", "x"); }
      export async function sneak(ctx) { await ctx.set("wallets", "x", 1); }
      export async function restock(ctx, { item, revision, stock }) {
        const listing = await ctx.get("shop", item);
        return ctx.set("shop", item, { ...listing.data, stock }, { condition: { revision } });
      }
      export async function create(ctx, { item }) {
        return ctx.set("shop", item, { price: 1, stock: 1 }, { condition: { absent: true } });
      }
      export async function discontinue(ctx, { item, revision }) {
        await ctx.delete("shop", item, { condition: { revision } });
      }
      export async function soldOut(ctx) {
        ctx.fail("CONFLICT", "품절입니다.", { reason: "sold_out", item: "sword" });
      }
      export async function peek(ctx, { where }) {
        return (await ctx.list("shop", { where })).documents.map((d) => d.id);
      }
    `;
    const call = (token: string | undefined, name: string, args?: unknown) =>
      executeCall({
        site: "alice",
        path: name.split("/"),
        method: "POST",
        body: { args },
        ...(token ? { bearer: { token, origin } } : {}),
      }) as Promise<{ result: any; written: string[] }>;
    beforeAll(async () => {
      for (const [name, read, write] of [
        ["shop", "member", "admin"],
        ["wallets", "member", "admin"],
        ["inventory", "member", "admin"],
      ])
        await owned("POST", [], { name, read, write });
      await callSiteObject("alice", "putFunctions", {
        site: "alice",
        file: "shop",
        source: SHOP,
      });
      await owned("PUT", ["shop", "sword"], {
        data: { price: 100, stock: 1 },
      });
    });

    test("a member buys: the rules hold, and what the function wrote is the owner's", async () => {
      const bob = await signIn("bob");
      await owned("PUT", ["wallets", bob.memberId], { data: { balance: 150 } });
      const bought = await call(bob.accessToken, "shop:buy", { item: "sword" });
      // The collections it changed, so the caller's SDK rereads only those.
      expect(bought.written).toEqual(["inventory", "shop", "wallets"]);
      expect(bought.result).toMatchObject({
        ok: true,
        balance: 50,
        owned: {
          data: { owner: bob.memberId, item: "sword" },
          createdBy: null,
          revision: "r1.1",
        },
      });
      expect(
        (await call(bob.accessToken, "shop:buy", { item: "sword" })).result,
      ).toEqual({ ok: false, reason: "sold_out" });
      expect((await call(bob.accessToken, "shop:mine")).result).toEqual([
        "sword",
      ]);
      // The member cannot change what the function wrote for them.
      await expect(
        as(bob.accessToken, "PUT", ["wallets", bob.memberId], {
          data: { balance: 1e9 },
        }),
      ).rejects.toMatchObject({ status: 403 });
      const roll = (await call(bob.accessToken, "shop:gacha")).result;
      expect(roll).toBeGreaterThanOrEqual(0);
      expect(roll).toBeLessThan(100);
      // A function's result is its own JSON, left as it is.
      expect((await call(bob.accessToken, "shop:versioned")).result).toEqual({
        version: "not a revision",
        list: [1, { version: 2 }],
      });
    });

    test("a function that fails changes nothing", async () => {
      const carol = await signIn("carol");
      await owned("PUT", ["shop", "shield"], { data: { price: 10, stock: 5 } });
      await owned("PUT", ["wallets", carol.memberId], {
        data: { balance: 100 },
      });
      for (const [name, message] of [
        ["shop:buyThenFail", "Function failed: Error: changed my mind"],
        ["shop:spin", "Function failed: it ran too long."],
        ["shop:flood", "Function failed: more than 25 writes."],
      ])
        await expect(
          call(carol.accessToken, name, { item: "shield" }),
        ).rejects.toMatchObject({ status: 400, message });
      await expect(
        call(carol.accessToken, "shop:buyThenReject", { item: "shield" }),
      ).rejects.toMatchObject({
        status: 409,
        code: "CONFLICT",
        message: "Purchase cancelled.",
      });
      expect((await call(carol.accessToken, "shop:mine")).result).toEqual([]);
      await expect(
        call(carol.accessToken, "shop:trespass"),
      ).rejects.toMatchObject({ status: 404 });
      expect(await owned("GET", ["wallets", carol.memberId])).toMatchObject({
        document: { data: { balance: 100 } },
      });
      expect(await owned("GET", ["shop", "shield"])).toMatchObject({
        document: { data: { stock: 5 } },
      });
      expect(
        await owned("GET", ["wallets", "x0"]).catch((e) => e),
      ).toMatchObject({ status: 404 });
    });

    test("bulk reads preserve order and missing positions; counts use filters in read-only functions", async () => {
      const bob = await signIn("bob");
      await owned("PUT", ["shop", "shield"], { data: { price: 10, stock: 5 } });
      const { result, written } = await call(bob.accessToken, "shop:lookup");
      expect(written).toEqual([]);
      expect(result).toMatchObject({
        rows: [{ id: "shield", data: { price: 10 } }, null, { id: "shield" }],
        empty: [],
        count: 1,
        zero: 0,
      });
      expect(result.rows[0]).toEqual(result.rows[2]);
      expect(result.rows[0].revision).toMatch(/^r1\./);
    });

    test("only members call, and only what the site has", async () => {
      const bob = await signIn("bob");
      await expect(call(undefined, "shop:buy")).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        executeCall({
          site: "alice",
          path: ["shop:buy"],
          method: "POST",
          adminUserId: owner,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(call(bob.accessToken, "shop:missing")).rejects.toMatchObject(
        {
          status: 404,
          message: "No function missing.",
        },
      );
      await expect(call(bob.accessToken, "nothing:buy")).rejects.toMatchObject({
        status: 404,
        message: "This site has no _naru/functions/nothing.js.",
      });
      await expect(call(bob.accessToken, "shop/../buy")).rejects.toMatchObject({
        status: 404,
      });
      await expect(call(bob.accessToken, "sh.op:buy")).rejects.toMatchObject({
        status: 400,
      });
    });

    test("declared read-only exports cannot write and have their own budget", async () => {
      const reader = await signIn("read-budget");
      // Buckets are wall-clock minutes in the Worker, whose clock Jest cannot
      // hold: start early in a minute so all 121 counted calls fall inside it.
      const into = Date.now() % 60_000;
      if (into > 20_000)
        await new Promise((resolve) => setTimeout(resolve, 60_500 - into));
      const minute = Math.floor(Date.now() / 60_000);
      await expect(call(undefined, "shop:versioned")).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        call(reader.accessToken, "shop:sneak"),
      ).rejects.toMatchObject({
        status: 400,
        message: "Function failed: read-only functions cannot write.",
      });
      for (let n = 1; n < 120; n++)
        expect(await call(reader.accessToken, "shop:versioned")).toMatchObject({
          result: { version: "not a revision" },
        });
      const refused = await call(reader.accessToken, "shop:versioned").then(
        () => undefined,
        (error) => error,
      );
      // A slower runner than this allows fails here, not as a missing 429.
      expect(Math.floor(Date.now() / 60_000)).toBe(minute);
      expect(refused).toMatchObject({ status: 429 });
      // Calls that may write still have their own 30.
      expect(
        (await call(reader.accessToken, "shop:gacha")).result,
      ).toBeGreaterThanOrEqual(0);
      // An invalid declaration refuses the whole revision.
      await expect(
        callSiteObject("alice", "putFunctions", {
          site: "alice",
          file: "broken",
          source: "export let readOnly = ['x']; export function x() {}",
        }),
      ).rejects.toThrow(/export const readOnly/);
      await callSiteObject("alice", "putFunctions", {
        site: "alice",
        file: "broken",
        source: null,
      });
    }, 90_000);

    test("conditional writes, failure details and where predicates in functions", async () => {
      const erin = await signIn("fern");
      await owned("PUT", ["shop", "lamp"], { data: { price: 5, stock: 1 } });
      const { document } = (await owned("GET", ["shop", "lamp"])) as any;
      // The control panel's answer carries the version; sites see revisions.
      const stale = encodeRevision(document.version);
      expect(
        (
          await call(erin.accessToken, "shop:restock", {
            item: "lamp",
            revision: stale,
            stock: 3,
          })
        ).result,
      ).toMatchObject({ data: { stock: 3 } });
      await expect(
        call(erin.accessToken, "shop:restock", {
          item: "lamp",
          revision: stale,
          stock: 9,
        }),
      ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
      await expect(
        call(erin.accessToken, "shop:create", { item: "lamp" }),
      ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
      await expect(
        call(erin.accessToken, "shop:discontinue", {
          item: "lamp",
          revision: stale,
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        call(erin.accessToken, "shop:soldOut"),
      ).rejects.toMatchObject({
        status: 409,
        code: "CONFLICT",
        message: "품절입니다.",
        details: { reason: "sold_out", item: "sword" },
      });
      expect(
        (
          await call(erin.accessToken, "shop:peek", {
            where: { all: [{ lte: ["price", 10] }, { in: ["stock", [3, 5]] }] },
          })
        ).result.sort(),
      ).toEqual(["lamp", "shield"]);
      await expect(
        call(erin.accessToken, "shop:peek", { where: { like: ["x", 1] } }),
      ).rejects.toMatchObject({ status: 400 });
    });

    test("a member's calls are limited per minute", async () => {
      const dave = await signIn("dave");
      const results = [];
      for (let n = 0; n < 31; n += 1)
        results.push(
          await call(dave.accessToken, "shop:gacha").then(
            () => 200,
            (error) => error.status,
          ),
        );
      if (results.at(-1) !== 200) {
        expect(results.slice(0, 30)).toEqual(Array(30).fill(200));
        expect(results.at(-1)).toBe(429);
      }
    });
  });
});
