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
  /** A member's query of who they are: what a token reaches, on a site. */
  const probe = (token: string | undefined, extra = {}) =>
    executeCall({
      site: "alice",
      path: ["whoami:me"],
      method: "POST",
      kind: "query",
      ...(token ? { bearer: { token, origin } } : {}),
      ...extra,
    }) as Promise<{ result: any }>;
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
      ["guestbook", "world", "create"],
      ["wall", "world", "world"],
      ["notes", "admin", "admin"],
    ])
      await owned("POST", [], { name, read, write });
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      folder: "queries",
      file: "whoami",
      source: "export function me(ctx) { return ctx.member; }",
    });
  });
  afterAll(async () => {
    if (ready) await teardownTestDatabase();
  });

  test("sign-in is for a page of a site that has the database", async () => {
    expect(await previewMemberSignIn(users.bob, input())).toEqual({
      site: "alice",
      notifications: true,
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

  test("the sign-in box sets whether the site's notifications reach the app", async () => {
    const consent = async () =>
      (
        await db
          .selectFrom("app_site_consents")
          .select("state")
          .where("user_id", "=", users.dave)
          .where("site_user_id", "=", owner)
          .executeTakeFirst()
      )?.state;
    // Ticked unless the account turned them off; an old page sends nothing.
    expect((await previewMemberSignIn(users.dave, input())).notifications).toBe(true);
    await approveMemberSignIn(users.dave, "dave-session", input());
    expect(await consent()).toBeUndefined();
    await approveMemberSignIn(users.dave, "dave-session", input(), true);
    expect(await consent()).toBe("allowed");
    await approveMemberSignIn(users.dave, "dave-session", input(), false);
    expect(await consent()).toBe("muted");
    expect((await previewMemberSignIn(users.dave, input())).notifications).toBe(false);
    await approveMemberSignIn(users.dave, "dave-session", input(), true);
    expect(await consent()).toBe("allowed");
  });

  test("a token works only from its page's origin, until it is revoked or its Naru session ends", async () => {
    const { accessToken, memberId } = await signIn("bob");
    await expect(probe(accessToken)).resolves.toMatchObject({
      result: { id: memberId },
    });
    await expect(
      probe(undefined, {
        bearer: { token: accessToken, origin: "https://evil.example" },
      }),
    ).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
    // Another site does not know it.
    await expect(
      probe(undefined, { site: "bob", bearer: { token: accessToken, origin } }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      revokeMemberToken(accessToken, "https://evil.example"),
    ).rejects.toMatchObject({ status: 401 });
    await revokeMemberToken(accessToken, origin);
    await revokeMemberToken(accessToken, origin);
    await expect(probe(accessToken)).rejects.toMatchObject({
      status: 401,
    });
    const second = await signIn("bob");
    await sql`update sessions set expires_at = now() - interval '1 second' where id = 'bob-session'`.execute(
      db,
    );
    await expect(probe(second.accessToken)).rejects.toMatchObject({
      status: 401,
    });
    await sql`update sessions set expires_at = now() + interval '60 days' where id = 'bob-session'`.execute(
      db,
    );
    // A deleted account's member stops at once.
    const third = await signIn("dave");
    await sql`update users set deleted_at = now() where id = ${users.dave}`.execute(
      db,
    );
    await expect(probe(third.accessToken)).rejects.toMatchObject({
      status: 401,
    });
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
    await probe(undefined, { bearer });
    expect(bearer.expiresAt).toBeUndefined();
    expect(await expiry()).toBe(before);
    // Past the halfway mark: pushed out a full window.
    await sql`update site_member_tokens set expires_at = now() + interval '1 day' where hash = ${hash}`.execute(
      db,
    );
    await probe(undefined, { bearer });
    expect(bearer.expiresAt).toBeGreaterThan(
      Date.now() + (MEMBER_TOKEN_SECONDS - 60) * 1000,
    );
    // Near the cap, only up to it.
    await sql`update site_member_tokens set expires_at = now() + interval '1 day',
      issued_at = now() - ${sql.raw(`interval '${MEMBER_TOKEN_CAP_SECONDS - 2 * 86400} seconds'`)} where hash = ${hash}`.execute(
      db,
    );
    delete bearer.expiresAt;
    await probe(undefined, { bearer });
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
    await expect(probe(member.accessToken)).resolves.toBeDefined();
    await sql`update users set supporter_comp = false where id = ${users.erin}`.execute(
      db,
    );
    try {
      await expect(probe(member.accessToken)).rejects.toMatchObject({
        status: 403,
        code: "ACCESS_DENIED",
      });
      await expect(code("erin")).rejects.toMatchObject({ status: 403 });
    } finally {
      await sql`update users set supporter_comp = true where id = ${users.erin}`.execute(
        db,
      );
    }
    await expect(probe(member.accessToken)).resolves.toBeDefined();
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
      await expect(probe(free.accessToken)).resolves.toBeDefined();
      // Withdrawing the exemption reaches members already signed in.
      await sql`update users set site_members_free = false where id = ${owner}`.execute(
        db,
      );
      await expect(probe(free.accessToken)).rejects.toMatchObject({
        status: 403,
        code: "ACCESS_DENIED",
      });
    } finally {
      await sql`update users set site_members_free = false where id = ${owner}`.execute(
        db,
      );
    }
  });

  test("the owner gives members roles, which a member's query reads", async () => {
    users.rolf = await insertUser("rolf");
    await sql`insert into sessions values ('rolf-session', ${users.rolf}, now() + interval '60 days')`.execute(
      db,
    );
    const member = await signIn("rolf");
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      folder: "queries",
      file: "roles",
      source: "export function me(ctx) { return ctx.member; }",
    });
    expect(
      await manageMembership(owner, "PATCH", {
        id: member.memberId,
        roles: ["staff", "writer"],
      }),
    ).toEqual({ id: member.memberId, roles: ["staff", "writer"] });
    const page = await manageMembership(owner, "GET");
    expect(
      page.members.find((row) => row.id === member.memberId)?.roles,
    ).toEqual(["staff", "writer"]);
    expect(
      await executeCall({
        site: "alice",
        method: "POST",
        path: ["roles:me"],
        kind: "query",
        bearer: { token: member.accessToken, origin },
      }),
    ).toMatchObject({
      result: { id: member.memberId, roles: ["staff", "writer"] },
    });
    // Only the owner's own members.
    await expect(
      manageMembership(owner, "PATCH", {
        id: crypto.randomUUID(),
        roles: ["staff"],
      }),
    ).rejects.toMatchObject({ status: 404 });
    await manageMembership(owner, "PATCH", { id: member.memberId, roles: [] });
  });

  test("approval and bans govern existing tokens across data, queries, mutations and uploads", async () => {
    const member = await signIn("erin");
    const bearer = { token: member.accessToken, origin };
    await callSiteObject("alice", "putFunctions", {
      site: "alice",
      folder: "mutations",
      file: "membership",
      source: "export function ping() { return true; }",
    });
    try {
      for (const status of ["pending", "banned"] as const) {
        await manageMembership(owner, "PATCH", { id: member.memberId, status });
        for (const [method, path, body] of [
          ["GET", ["wall"], undefined],
          ["GET", ["wall", "anything"], undefined],
          ["POST", ["guestbook"], { data: "denied" }],
          ["PUT", ["wall", member.memberId], { data: "denied" }],
          ["DELETE", ["wall", member.memberId], undefined],
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
        for (const call of [
          probe(member.accessToken),
          executeCall({
            site: "alice",
            method: "POST",
            path: ["membership:ping"],
            kind: "mutation",
            bearer,
          }),
        ])
          await expect(call).rejects.toMatchObject({
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
        await expect(owned("GET", ["notes"])).resolves.toBeDefined();
      }
      await expect(code("erin")).rejects.toMatchObject({ status: 403 });
      await manageMembership(owner, "PATCH", {
        id: member.memberId,
        status: "approved",
      });
      await expect(probe(member.accessToken)).resolves.toBeDefined();
      await expect(
        executeCall({
          site: "alice",
          method: "POST",
          path: ["membership:ping"],
          kind: "mutation",
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
      await expect(probe(frank.accessToken)).rejects.toMatchObject({
        status: 403,
      });
      await manageMembership(owner, "PATCH", { admission: "open" });
      expect((await manageMembership(owner, "GET")).members).toContainEqual(
        expect.objectContaining({ id: frank.memberId, status: "pending" }),
      );
      const grace = await signIn("grace");
      await expect(probe(grace.accessToken)).resolves.toBeDefined();
      await manageMembership(owner, "PATCH", {
        id: frank.memberId,
        status: "approved",
      });
      await expect(probe(frank.accessToken)).resolves.toBeDefined();
      const list = await manageMembership(owner, "GET");
      expect(list.admission).toBe("open");
      expect(
        list.members!.every(
          (m) =>
            Object.keys(m).sort().join(",") === "createdAt,id,roles,status",
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
      await expect(probe(bob.accessToken)).resolves.toBeDefined();
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

  test("members' queries count against the site's monthly budget, like visitors' reads", async () => {
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
      await probe(bob.accessToken);
      await as(undefined, "GET", ["wall"]);
      await expect(probe(bob.accessToken)).rejects.toMatchObject({
        status: 429,
        code: "RATE_LIMITED",
      });
      await expect(owned("GET", ["notes"])).resolves.toBeDefined();
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

  test("members reach the site's data through its queries and mutations, not its collections", async () => {
    const bob = await signIn("bob");
    for (const [method, path, body] of [
      ["GET", ["wall"], undefined],
      ["GET", ["notes"], undefined],
      ["POST", ["guestbook"], { data: "hi" }],
      ["PUT", ["wall", bob.memberId], { data: "mine" }],
    ] as const)
      await expect(
        as(bob.accessToken, method, [...path], body),
      ).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    // As a visitor, the same page reads and adds as 1.0.0's visitors do.
    await expect(as(undefined, "GET", ["wall"])).resolves.toBeDefined();
    const added = await as(undefined, "POST", ["guestbook"], { data: "hi" });
    // Nothing a visitor writes names an author.
    expect(added).toMatchObject({ createdBy: null });
    await owned("DELETE", ["guestbook", added.id]);
    await expect(
      owned("PATCH", ["wall"], { read: "member", write: "world" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      owned("POST", [], {
        name: "members_only",
        read: "admin",
        write: "member",
      }),
    ).rejects.toMatchObject({ status: 400 });
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

  test("visitors add to a create collection, and only the owner changes it", async () => {
    await owned("POST", [], { name: "guests", read: "world", write: "create" });
    try {
      // A body's other fields are no part of the write.
      const added = (await as(undefined, "POST", ["guests"], {
        data: { name: "길손", text: "hi" },
        secret: "pass1234",
      })) as any;
      expect(added.data).toEqual({ name: "길손", text: "hi" });
      await expect(
        as(undefined, "PUT", ["guests", added.id], { data: { name: "x" } }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        as(undefined, "DELETE", ["guests", added.id]),
      ).rejects.toMatchObject({ status: 403 });
      await owned("DELETE", ["guests", added.id]);
    } finally {
      await owned("DELETE", ["guests"]);
    }
  });

  test("unique fields refuse a second document with the same value, on every write path", async () => {
    await owned("POST", [], { name: "nicks", read: "world", write: "world" });
    await as(undefined, "PUT", ["nicks", "bob"], { data: { nick: "lime" } });
    await as(undefined, "PUT", ["nicks", "carol"], { data: { nick: "lime" } });
    // Existing duplicates refuse the setting.
    await expect(
      owned("PATCH", ["nicks"], {
        read: "world",
        write: "world",
        unique: ["nick"],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await as(undefined, "PUT", ["nicks", "carol"], { data: { nick: "lemon" } });
    await owned("PATCH", ["nicks"], {
      read: "world",
      write: "world",
      unique: ["nick"],
    });
    expect(
      ((await owned("GET", [])) as any).collections.find(
        (c: any) => c.name === "nicks",
      ),
    ).toMatchObject({ unique: ["nick"] });
    await expect(
      as(undefined, "PUT", ["nicks", "carol"], { data: { nick: "lime" } }),
    ).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      details: { unique: "nick" },
    });
    await expect(
      as(undefined, "POST", ["nicks"], { data: { nick: "lime" } }),
    ).rejects.toMatchObject({ status: 409, details: { unique: "nick" } });
    // Rewriting a document keeps its own value.
    await as(undefined, "PUT", ["nicks", "bob"], {
      data: { nick: "lime", bio: "hi" },
    });
    // A number is not the same value as a string.
    await as(undefined, "PUT", ["nicks", "carol"], { data: { nick: 7 } });
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
      read: "world",
      write: "world",
      unique: null,
    });
    await owned("PUT", ["nicks", "x"], { data: { nick: "lime" } });
    await owned("DELETE", ["nicks"]);
  });

  test("live connections carry a member's live queries until their access ends", async () => {
    const WebSocketClient = (globalThis as { WebSocket?: typeof WebSocket })
      .WebSocket;
    if (!WebSocketClient) return;
    const bob = await signIn("fern");
    await callSiteObject("alice", "configure", {
      ownerId: String(owner),
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
    });
    const base = `${process.env.EDGE_WORKER_URL!.replace(/^http/, "ws")}/api/data/v1/alice/_live`;
    const open = (query: string) =>
      new Promise<{
        socket: WebSocket;
        heard: unknown[];
        closed: Promise<number>;
      }>((resolve, reject) => {
        const socket = new WebSocketClient(`${base}${query}`);
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
    const member = await open(`?ticket=${ticket}`);
    const visitor = await open("");
    await expect(
      open("?ticket=forged.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).rejects.toThrow();
    // Visitors get no ticket: they connect without one.
    await expect(
      executeLiveTicket({ site: "alice", path: ["_live"], method: "POST" }),
    ).rejects.toMatchObject({ status: 401 });
    // Each live query runs as whoever the connection is.
    for (const connection of [member, visitor])
      connection.socket.send(
        JSON.stringify({ type: "subscribe", id: "me", query: "whoami:me" }),
      );
    const settle = () => new Promise((done) => setTimeout(done, 300));
    await settle();
    expect(member.heard).toEqual([
      {
        type: "result",
        id: "me",
        result: { id: bob.memberId, roles: [] },
      },
    ]);
    expect(visitor.heard).toEqual([{ type: "result", id: "me", result: null }]);
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

    test("every upload's references are tracked, in any field or HTML, and nothing is deleted", async () => {
      const bob = await signIn("bob");
      const upload = async (extra = {}) => {
        const authorized = await media(bob.accessToken, "POST", [], {
          ...file,
          ...extra,
        });
        return (await media(bob.accessToken, "PUT", [authorized.id])).file;
      };
      const kept = await upload();
      const swapped = await upload();
      const unused = await upload();
      const referenced = async () =>
        (
          await callSiteObject<string[]>("alice", "mediaReferences", {
            ids: [kept.id, swapped.id, unused.id],
          })
        ).sort();
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
          data: { html: `<img src="${kept.url}">` },
        });
        expect(await referenced()).toEqual([kept.id, swapped.id].sort());
        // The owner's library marks what no document names, and lists
        // uploads never finished, which stay until deleted.
        const started = await media(bob.accessToken, "POST", [], file);
        const listed = (
          (await executeMedia({
            site: "alice",
            path: [],
            method: "GET",
            body: {},
            adminUserId: owner,
            size: 100,
          })) as { files: Record<string, unknown>[] }
        ).files;
        const shown = (id: string) => listed.find((entry) => entry.id === id);
        expect(shown(kept.id)).toMatchObject({ referenced: true });
        expect(shown(unused.id)).toMatchObject({ referenced: false });
        expect(shown(started.id)).toMatchObject({ unfinished: true });
        expect(shown(started.id)).not.toHaveProperty("referenced");
        // Editing out an upload, or deleting what named it, only unmarks it:
        // media may be linked from anywhere, so nothing is released.
        await owned("PUT", ["posts_m", "a"], { data: { image: kept.url } });
        expect(await referenced()).toEqual([kept.id]);
        await owned("DELETE", ["posts_m", "a"]);
        await owned("DELETE", ["posts_m", "b"]);
        expect(await referenced()).toEqual([]);
        await owned("PUT", ["posts_m", "c"], { data: { image: unused.url } });
        await owned("DELETE", ["posts_m"]);
        expect(await referenced()).toEqual([]);
        const rows = await db
          .selectFrom("site_data_files")
          .select(["id", "deleted_at"])
          .where("id", "in", [kept.id, swapped.id, unused.id])
          .execute();
        expect(rows.every((row) => row.deleted_at === null)).toBe(true);
        expect(rows).toHaveLength(3);
      } finally {
        await owned("DELETE", ["posts_m"]).catch(() => {});
      }
    });

    test("the owner's library finds uploads the site's tables name, as it asks", async () => {
      const bob = await signIn("bob");
      const authorized = await media(bob.accessToken, "POST", [], file);
      const inTable = (await media(bob.accessToken, "PUT", [authorized.id]))
        .file;
      await callSiteObject("alice", "putFunctions", {
        site: "alice",
        folder: "migrations",
        file: "0001_gallery",
        source: "CREATE TABLE gallery (id INTEGER PRIMARY KEY, image TEXT);",
        publish: false,
      });
      await callSiteObject("alice", "putFunctions", {
        site: "alice",
        folder: "mutations",
        file: "gallery",
        source: `export async function add(ctx, { image }) { await ctx.sql\`INSERT INTO gallery (image) VALUES (\${image})\`; }
          export async function clear(ctx) { await ctx.sql\`DELETE FROM gallery\`; }`,
      });
      const gallery = (name: string, args: unknown = null) =>
        callSiteObject("alice", "call", {
          ownerId: String(owner),
          site: "alice",
          member: null,
          kind: "mutation",
          file: "gallery",
          name,
          args,
        });
      const tables = () =>
        executeMedia({
          site: "alice",
          path: [],
          method: "GET",
          body: {},
          adminUserId: owner,
          tableReferences: true,
        }) as Promise<Record<string, any>>;
      await gallery("add", { image: inTable.url });
      expect(await tables()).toEqual({
        tableReferences: {
          [inTable.id]: [{ table: "gallery", column: "image" }],
        },
        partial: false,
      });
      // The listing itself is the documents' answer, which no table changes.
      const listed = (
        (await executeMedia({
          site: "alice",
          path: [],
          method: "GET",
          body: {},
          adminUserId: owner,
          size: 100,
        })) as { files: Record<string, unknown>[] }
      ).files;
      expect(listed.find((entry) => entry.id === inTable.id)).toMatchObject({
        referenced: false,
      });
      // Only the owner's control panel asks.
      await expect(
        executeMedia({
          site: "alice",
          path: [],
          method: "GET",
          body: {},
          bearer: { token: bob.accessToken, origin },
          tableReferences: true,
        }),
      ).rejects.toMatchObject({ status: 403 });
      // Within the minute the same look is answered again, but one after a
      // write would scan again: refused, so reopening cannot keep the
      // Worker scanning (table-media-references.test.ts sees the row gone).
      expect(await tables()).toEqual({
        tableReferences: {
          [inTable.id]: [{ table: "gallery", column: "image" }],
        },
        partial: false,
      });
      await gallery("clear");
      await expect(tables()).rejects.toMatchObject({
        status: 429,
        code: "RATE_LIMITED",
      });
    });

    test("a site's first media listing records the references its documents already had", async () => {
      // Documents written while only some uploads were tracked: an
      // imported site has documents and no references at all.
      const ownerId = "0190f1a2-0000-7000-8000-00000000000a";
      const upload = "0190f1a2-0000-7000-8000-0000000000b1";
      try {
        await callSiteObject("media-backfill", "import", {
          ownerId,
          collections: [
            {
              id: "0190f1a2-0000-7000-8000-0000000000c1",
              name: "posts",
              read_access: "world",
              write_access: "admin",
            },
          ],
          documents: [
            {
              collection_id: "0190f1a2-0000-7000-8000-0000000000c1",
              id: "old",
              data: JSON.stringify({
                html: `<img src="https://media.naru.pub/${ownerId}/${upload}.png">`,
              }),
              size_bytes: 80,
              version: 1,
              created_at: 0,
              updated_at: 0,
              created_by: null,
            },
          ],
        });
        expect(
          await callSiteObject<string[]>("media-backfill", "mediaReferences", {
            ids: [upload, "0190f1a2-0000-7000-8000-0000000000b2"],
          }),
        ).toEqual([upload]);
      } finally {
        await eraseSiteData("media-backfill");
      }
    });

    test("a member uploads into the site's media, and finishes only their own", async () => {
      const bob = await signIn("bob");
      const carol = await signIn("carol");
      // Site code reads the upload as it was finished (_naru_uploads).
      await callSiteObject("alice", "putFunctions", {
        site: "alice",
        folder: "queries",
        file: "uploads",
        source: `export async function get(ctx, { id }) {
            const { rows } = await ctx.sql\`SELECT * FROM _naru_uploads WHERE id = \${id}\`;
            return rows[0] ?? null;
          }`,
      });
      const uploadCall = (name: string, args: unknown) =>
        executeCall({
          site: "alice",
          path: [`uploads:${name}`],
          method: "POST",
          kind: "query",
          body: { args },
          bearer: { token: bob.accessToken, origin },
        }).then((answer) => (answer as { result: unknown }).result);
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
      expect(await uploadCall("get", { id: authorized.id })).toMatchObject({
        id: authorized.id,
        member: bob.memberId,
        name: "log.png",
        type: "image/png",
        size: 3,
      });
      // Members cannot list files or delete another member's upload.
      await expect(media(bob.accessToken, "GET", [])).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        media(carol.accessToken, "DELETE", [authorized.id]),
      ).rejects.toMatchObject({ status: 403 });
      await media(bob.accessToken, "DELETE", [authorized.id]);
      expect(await uploadCall("get", { id: authorized.id })).toBe(null);
      await media(bob.accessToken, "DELETE", [authorized.id]);
      await expect(
        media(bob.accessToken, "PUT", [authorized.id]),
      ).rejects.toMatchObject({ status: 404 });
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
});
