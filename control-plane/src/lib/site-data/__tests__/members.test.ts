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
import { executeBatch, executeCall, executeData } from "../service";
import { manageMembership } from "../membership";
import { membershipStatusRequest } from "../membership-http";
import { digest } from "../owner-auth";
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
    for (const login of ["bob", "carol", "dave", "read-budget"])
      users[login] = await insertUser(login);
    users.erin = await insertUser("erin", false);
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
  afterEach(() => {
    delete process.env.SITE_MEMBERS_SUPPORTERS_ONLY;
  });

  test("sign-in is for a page of a site that has the database", async () => {
    expect(await previewMemberSignIn(users.bob, input())).toEqual({
      site: "alice",
      mayJoin: true,
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
      previewMemberSignIn(users.bob, input({ site: "erin" })),
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

  test("supporters only, when the server says so, also for members already signed in", async () => {
    const free = await signIn("erin");
    await expect(as(free.accessToken, "GET", ["board"])).resolves.toBeDefined();
    process.env.SITE_MEMBERS_SUPPORTERS_ONLY = "1";
    expect(await previewMemberSignIn(users.erin, input())).toMatchObject({
      mayJoin: false,
    });
    await expect(
      approveMemberSignIn(users.erin, "erin-session", input()),
    ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    await expect(as(free.accessToken, "GET", ["board"])).rejects.toMatchObject({
      status: 403,
      code: "ACCESS_DENIED",
    });
    // A supporter is unaffected.
    const supporter = await signIn("bob");
    await expect(
      as(supporter.accessToken, "GET", ["board"]),
    ).resolves.toBeDefined();
  });

  test("approval and bans govern existing tokens across data, functions and uploads", async () => {
    const member = await signIn("erin");
    const bearer = { token: member.accessToken, origin };
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      file: "membership",
      source: "export function ping() { return true; }",
    });
    const statusRequest = () =>
      membershipStatusRequest(
        new Request("https://naru.pub/api/membership/v1/alice", {
          headers: {
            Authorization: `Bearer ${member.accessToken}`,
            Origin: origin,
          },
        }),
        "alice",
      );
    try {
      for (const status of ["pending", "banned"] as const) {
        await manageMembership(owner, "PATCH", { id: member.memberId, status });
        const response = await statusRequest();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ id: member.memberId, status });
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
          ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
        }
        await expect(
          executeCall({
            site: "alice",
            method: "POST",
            path: ["membership", "ping"],
            bearer,
          }),
        ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
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
          path: ["membership", "ping"],
          bearer,
        }),
      ).resolves.toEqual({ result: true });
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
      // Listing and deleting stay the control panel's.
      await expect(media(bob.accessToken, "GET", [])).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        media(bob.accessToken, "DELETE", [authorized.id]),
      ).rejects.toMatchObject({ status: 403 });
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
      export function buy(ctx, { item }) {
        const listing = ctx.get("shop", item);
        if (!listing) return { ok: false, reason: "no_such_item" };
        if (listing.data.stock < 1) return { ok: false, reason: "sold_out" };
        const wallet = ctx.get("wallets", ctx.member.id);
        const balance = wallet ? wallet.data.balance : 0;
        if (balance < listing.data.price) return { ok: false, reason: "not_enough_money" };
        ctx.set("wallets", ctx.member.id, { balance: balance - listing.data.price });
        ctx.set("shop", item, { ...listing.data, stock: listing.data.stock - 1 });
        const owned = ctx.add("inventory", { owner: ctx.member.id, item });
        return { ok: true, balance: balance - listing.data.price, owned };
      }
      export function buyThenFail(ctx, args) {
        buy(ctx, args);
        throw new Error("changed my mind");
      }
      export function mine(ctx) {
        return ctx.list("inventory", { filter: { owner: ctx.member.id } }).documents.map((d) => d.data.item);
      }
      export function gacha(ctx) {
        return Math.floor(ctx.random() * 100);
      }
      export function versioned() {
        return { version: "not a revision", list: [1, { version: 2 }] };
      }
      export function spin() { for (;;) {} }
      export function flood(ctx) { for (let i = 0; ; i++) ctx.set("wallets", "x" + i, i); }
      export function trespass(ctx) { ctx.get("nowhere", "x"); }
    `;
    const call = (
      token: string | undefined,
      name: string,
      args?: unknown,
      readonly = false,
    ) =>
      executeCall(
        {
          site: "alice",
          path: name.split("/"),
          method: "POST",
          body: { args },
          ...(token ? { bearer: { token, origin } } : {}),
        },
        readonly,
      ) as Promise<{ result: any }>;
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
      const bought = await call(bob.accessToken, "shop/buy", { item: "sword" });
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
        (await call(bob.accessToken, "shop/buy", { item: "sword" })).result,
      ).toEqual({ ok: false, reason: "sold_out" });
      expect((await call(bob.accessToken, "shop/mine")).result).toEqual([
        "sword",
      ]);
      // The member cannot change what the function wrote for them.
      await expect(
        as(bob.accessToken, "PUT", ["wallets", bob.memberId], {
          data: { balance: 1e9 },
        }),
      ).rejects.toMatchObject({ status: 403 });
      const roll = (await call(bob.accessToken, "shop/gacha")).result;
      expect(roll).toBeGreaterThanOrEqual(0);
      expect(roll).toBeLessThan(100);
      // A function's result is its own JSON, left as it is.
      expect((await call(bob.accessToken, "shop/versioned")).result).toEqual({
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
        ["shop/buyThenFail", "Function failed: Error: changed my mind"],
        ["shop/spin", "Function failed: it ran too long."],
        ["shop/flood", "Function failed: more than 25 writes."],
      ])
        await expect(
          call(carol.accessToken, name, { item: "shield" }),
        ).rejects.toMatchObject({ status: 400, message });
      await expect(
        call(carol.accessToken, "shop/trespass"),
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

    test("only members call, and only what the site has", async () => {
      const bob = await signIn("bob");
      await expect(call(undefined, "shop/buy")).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        executeCall({
          site: "alice",
          path: ["shop", "buy"],
          method: "POST",
          adminUserId: owner,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(call(bob.accessToken, "shop/missing")).rejects.toMatchObject(
        {
          status: 404,
          message: "No function missing.",
        },
      );
      await expect(call(bob.accessToken, "nothing/buy")).rejects.toMatchObject({
        status: 404,
        message: "This site has no _naru/functions/nothing.js.",
      });
      await expect(call(bob.accessToken, "shop/../buy")).rejects.toMatchObject({
        status: 404,
      });
      await expect(call(bob.accessToken, "sh.op/buy")).rejects.toMatchObject({
        status: 400,
      });
    });

    test("reads authenticate and have a separate bounded budget", async () => {
      const reader = await signIn("read-budget");
      await expect(
        call(undefined, "shop/versioned", null, true),
      ).rejects.toMatchObject({ status: 401 });
      for (let n = 0; n < 30; n++)
        await call(reader.accessToken, "shop/versioned");
      await expect(
        call(reader.accessToken, "shop/versioned"),
      ).rejects.toMatchObject({ status: 429 });
      for (let n = 0; n < 120; n++)
        expect(
          await call(reader.accessToken, "shop/versioned", null, true),
        ).toMatchObject({ result: { version: "not a revision" } });
      await expect(
        call(reader.accessToken, "shop/versioned", null, true),
      ).rejects.toMatchObject({ status: 429 });
    });

    test("a member's calls are limited per minute", async () => {
      const dave = await signIn("dave");
      const results = [];
      for (let n = 0; n < 31; n += 1)
        results.push(
          await call(dave.accessToken, "shop/gacha").then(
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
