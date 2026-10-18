import { afterAll, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { createHash } from "node:crypto";

// The site's outbox, as the Worker would hold it (edge/src/notify.ts).
const outboxes = new Map<string, { id: string; members: string[]; title: string; body: string; path: string; at: number }[]>();
jest.mock("@/lib/edge/client", () => ({
  siteDataWorker: () => ({ base: "http://worker", secret: "s" }),
  requestWorker: async () =>
    Response.json({
      value: {
        sites: [...outboxes].filter(([, rows]) => rows.length).map(([s]) => s),
      },
    }),
  answerOf: async (response: Response) => (await response.json()).value,
  callSiteObject: async (site: string, operation: string, input: any) => {
    const rows = outboxes.get(site) ?? [];
    if (operation === "notifyOutbox") return rows.slice(0, input.limit);
    if (operation === "ackNotifyOutbox") {
      outboxes.set(site, rows.filter((row) => !input.ids.includes(row.id)));
      return { pending: outboxes.get(site)!.length };
    }
    throw new Error(`unexpected ${operation}`);
  },
}));

// Required after the mocks: this transform does not hoist jest.mock above imports.
const { sql } = require("kysely") as typeof import("kysely");
const { db } = require("@/lib/database") as typeof import("@/lib/database");
const tokens = require("../tokens") as typeof import("../tokens");
const inbox = require("../inbox") as typeof import("../inbox");
const { deliverAppNotifications } =
  require("../delivery") as typeof import("../delivery");
const { showcasePage } = require("../showcase") as typeof import("../showcase");
const { appResponse, appUser } = require("../http") as typeof import("../http");
const { getHomepageUrl } = require("@/lib/site-urls") as typeof import("@/lib/site-urls");
const moderation = require("../moderation") as typeof import("../moderation");
const stars = require("../stars") as typeof import("../stars");
const { pushStarredUpdates } =
  require("../starred-updates") as typeof import("../starred-updates");
const { siteLine, siteOrigins } = require("../sites") as typeof import("../sites");
const siteStars = require("@/lib/site-stars") as typeof import("@/lib/site-stars");
const siteModeration =
  require("@/lib/site-moderation") as typeof import("@/lib/site-moderation");
const { databaseEntitledUntil } =
  require("@/lib/edge/sync") as typeof import("@/lib/edge/sync");

// Runs against the disposable database of scripts/test-payments-db.sh.
const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

const s256 = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const verifier = "v".repeat(43);

integration("the Naru app's API", () => {
  let reader: string;
  let siteId: string;
  let memberId: string;
  const ids: string[] = [];

  beforeAll(async () => {
    const insert = async (name: string, extra = sql``) => {
      const id = (
        await sql<{ id: string }>`insert into users (login_name, password_hash, supporter_comp)
          values (${name}, 'x', true) returning id`.execute(db)
      ).rows[0].id;
      ids.push(id);
      return id;
    };
    reader = await insert("app-reader");
    siteId = await insert("app-site");
    await db
      .updateTable("users")
      .set({
        site_title: "앱 게시판",
        discoverable: true,
        site_rendered_at: new Date(),
        site_updated_at: new Date(),
      })
      .where("id", "=", siteId)
      .execute();
    memberId = (
      await db
        .insertInto("site_members")
        .values({ site_user_id: siteId, user_id: reader, status: "approved" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  });

  afterAll(async () => {
    await sql`delete from users where id in (${sql.join(ids)})`.execute(db);
    await db.destroy();
  });

  async function signIn(redirectUri = tokens.APP_REDIRECT_URI) {
    const input = tokens.authorizeInput({
      client: "ios",
      redirect_uri: redirectUri,
      state: "s".repeat(32),
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
    });
    const redirect = new URL(await tokens.approveAuthorization(reader, input));
    expect(redirect.href.startsWith(redirectUri + "?")).toBe(true);
    expect(redirect.searchParams.get("state")).toBe("s".repeat(32));
    const code = redirect.searchParams.get("code")!;
    return { code, redirectUri };
  }

  test("returns the Apple app's sign-in to naru.pub's own page", async () => {
    expect(tokens.appHttpsCallback()).toMatch(/^https:\/\/[^/]+\/app\/callback$/);
    const grant = await signIn(tokens.appHttpsCallback());
    // A code returns only to the address it was asked for.
    await expect(
      tokens.exchangeCode({ ...grant, redirectUri: tokens.APP_REDIRECT_URI, verifier }),
    ).rejects.toMatchObject({ status: 400 });
    const fresh = await signIn(tokens.appHttpsCallback());
    expect((await tokens.exchangeCode({ ...fresh, verifier })).account).toEqual({
      loginName: "app-reader",
    });
  });

  test("signs in with a code and its PKCE verifier, once", async () => {
    const grant = await signIn();
    await expect(
      tokens.exchangeCode({ ...grant, verifier: "w".repeat(43) }),
    ).rejects.toMatchObject({ status: 400 });
    // A wrong verifier spends the code too.
    await expect(
      tokens.exchangeCode({ ...grant, verifier }),
    ).rejects.toMatchObject({ status: 400 });

    const fresh = await signIn();
    const { token, account } = await tokens.exchangeCode({ ...fresh, verifier });
    expect(account).toEqual({ loginName: "app-reader" });
    expect(token).toMatch(/^a\.[A-Za-z0-9_-]{43}$/);
    const request = new Request("https://naru.pub/api/app/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect((await appUser(request)).loginName).toBe("app-reader");
  });

  test("refuses an unknown token as AUTH_REQUIRED", async () => {
    const response = await appResponse(async () =>
      appUser(
        new Request("https://naru.pub/", {
          headers: { Authorization: `Bearer a.${"x".repeat(43)}` },
        }),
      ),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  });

  test("refuses sign-in requests the app could not have made", () => {
    for (const params of [
      { redirect_uri: "https://evil.example/" },
      { redirect_uri: "https://evil.example/app/callback" },
      { redirect_uri: "naru://auth" },
      { client: "web" },
      { code_challenge_method: "plain" },
    ])
      expect(() =>
        tokens.authorizeInput({
          client: "ios",
          redirect_uri: tokens.APP_REDIRECT_URI,
          state: "s".repeat(32),
          code_challenge: s256(verifier),
          code_challenge_method: "S256",
          ...params,
        }),
      ).toThrow();
  });

  test("shows discoverable sites in the showcase", async () => {
    const { sites } = await showcasePage(1);
    const site = sites.find((entry) => entry.name === "app-site");
    expect(site?.screenshotUrl).toContain("_screenshots/app-site.png");
  });

  test("searches the showcase by name and title", async () => {
    const names = async (search: string) =>
      (await showcasePage(1, undefined, search)).sites.map((site) => site.name);
    expect(await names("APP-SITE")).toEqual(["app-site"]);
    expect(await names("앱 게시")).toEqual(["app-site"]);
    expect(await names("app_site")).toEqual([]);
    expect(await names("%")).toEqual([]);
  });

  test("finds a site by its exact name, listed or not, unless operators hid it", async () => {
    const found = async (search: string) =>
      (await showcasePage(1, undefined, search)).sites.map((site) => [
        site.name,
        site.screenshotUrl.endsWith("/app/no-preview.png"),
      ]);
    // app-reader is not discoverable: only its exact name finds it, and its
    // card has no screenshot. Before anything is published, not even that.
    expect(await found("app-reader")).toEqual([]);
    await db.updateTable("users").set({ site_updated_at: new Date() }).where("id", "=", reader).execute();
    expect(await found("APP-READER")).toEqual([["app-reader", true]]);
    expect(await found("app-read")).toEqual([]);
    // The exact match first, then the listed sites that contain it.
    expect(await found("app-site")).toEqual([["app-site", false]]);

    // Hidden by operators: out of the showcase and every search.
    for (const level of ["hidden", "suspended"] as const) {
      await db.updateTable("users").set({ site_moderation: level }).where("id", "in", [siteId, reader]).execute();
      expect((await showcasePage(1)).sites.map((site) => site.name)).not.toContain("app-site");
      expect(await found("app-site")).toEqual([]);
      expect(await found("app-reader")).toEqual([]);
    }
    await db.updateTable("users").set({ site_moderation: null }).where("id", "in", [siteId, reader]).execute();
  });

  test("stars sites for an account, discoverable or not", async () => {
    const { token } = await tokens.exchangeCode({ ...(await signIn()), verifier });
    const user = (await tokens.appTokenUser(token))!;
    await siteStars.starSite(user.id, "app-site");
    await siteStars.starSite(user.id, "app-site");
    // The reader's own site is not discoverable, and can be starred all the same.
    await siteStars.starSite(user.id, "app-reader");
    expect((await stars.listStarredSites(user)).sites.map((site) => site.name)).toEqual([
      "app-reader",
      "app-site",
    ]);
    await siteStars.unstarSite(user.id, "app-reader");
    await expect(siteStars.starSite(user.id, "no-such-site")).rejects.toMatchObject({
      status: 404,
    });
    // A site operators suspended is left out; one they hid stays, without
    // its screenshot.
    await siteStars.starSite(user.id, "app-site");
    await db.updateTable("users").set({ site_moderation: "hidden" }).where("id", "=", siteId).execute();
    expect((await stars.listStarredSites(user)).sites).toMatchObject([
      { name: "app-site", screenshotUrl: expect.stringMatching(/\/app\/no-preview\.png$/) },
    ]);
    await db.updateTable("users").set({ site_moderation: "suspended" }).where("id", "=", siteId).execute();
    expect((await stars.listStarredSites(user)).sites).toEqual([]);
    await db.updateTable("users").set({ site_moderation: null }).where("id", "=", siteId).execute();
    // Hiding a starred site unstars it.
    await moderation.hideSite(user, "app-site");
    expect((await stars.listStarredSites(user)).sites).toEqual([]);
    await moderation.showSite(user, "app-site");
  });

  test("delivers ctx.notify to the member's account, after it allows the site", async () => {
    const { token } = await tokens.exchangeCode({ ...(await signIn()), verifier });
    const user = (await tokens.appTokenUser(token))!;
    await inbox.registerDevice(user, {
      platform: "apns",
      token: "ab".repeat(32),
      environment: "sandbox",
      bundleId: "pub.naru",
    });
    const sent: { token: string; title: string; badge: number }[] = [];
    const siteLines: string[] = [];
    const sender = {
      send: async (
        device: { token: string },
        message: { title: string; badge: number; siteTitle: string },
      ) => {
        sent.push({ token: device.token, title: message.title, badge: message.badge });
        siteLines.push(message.siteTitle);
        return "delivered" as const;
      },
      close() {},
    };
    const queue = (id: string, title: string) =>
      outboxes.set("app-site", [
        ...(outboxes.get("app-site") ?? []),
        {
          id,
          // A stranger's id is skipped without a trace.
          members: [memberId, "0199f2a4-7c1e-7d3a-9b2f-000000000000"],
          title,
          body: "본문",
          path: "/posts/1",
          at: Date.now(),
        },
      ]);

    // First notification: the site becomes pending; stored, not pushed.
    queue("0199f2a4-0000-7000-8000-000000000001", "첫 알림");
    expect(await deliverAppNotifications(sender)).toMatchObject({ stored: 1, pushed: 0 });
    expect(outboxes.get("app-site")).toEqual([]);
    expect((await inbox.listSites(user)).sites).toMatchObject([
      { site: { name: "app-site", title: "앱 게시판" }, state: "pending" },
    ]);
    expect((await inbox.listNotifications(user, null)).notifications).toEqual([]);

    // Allowed: what was sent shows, and the next one is pushed.
    await inbox.setSiteState(user, "app-site", { state: "allowed" });
    expect((await inbox.listNotifications(user, null)).notifications).toMatchObject([
      { title: "첫 알림", url: `${getHomepageUrl("app-site")}/posts/1`, readAt: null },
    ]);
    queue("0199f2a4-0000-7000-8000-000000000002", "둘째 알림");
    expect(await deliverAppNotifications(sender)).toMatchObject({ stored: 1, pushed: 1 });
    expect(sent).toEqual([{ token: "ab".repeat(32), title: "둘째 알림", badge: 2 }]);
    // The site is named by its address first, then the title it gave itself.
    expect(siteLines).toEqual([
      `${new URL(getHomepageUrl("app-site")).host} · 앱 게시판`,
    ]);
    // A title that would pose as Naru, or crowd the address out, cannot.
    expect(siteLine(null, "https://a.example")).toBe("a.example");
    expect(siteLine(" a.example ", "https://a.example")).toBe("a.example");
    expect(siteLine("Naru\n  보안팀", "https://a.example")).toBe(
      "a.example · Naru 보안팀",
    );
    expect(siteLine("🥑".repeat(40), "https://a.example")).toBe(
      `a.example · ${"🥑".repeat(29)}…`,
    );

    // A row delivered twice (its acknowledgement lost) is stored once.
    queue("0199f2a4-0000-7000-8000-000000000002", "둘째 알림");
    expect(await deliverAppNotifications(sender)).toMatchObject({ stored: 0 });

    // A site served at its own domain is opened there, where its members are
    // signed in; the address is resolved when listed, so it follows changes.
    await db.updateTable("users").set({ supporter_comp: true }).where("id", "=", siteId).execute();
    await db
      .insertInto("custom_domains")
      .values({
        user_id: siteId,
        hostname: "Board.Example",
        cloudflare_hostname_id: "cf-1",
        cloudflare_status: "active",
        ssl_status: "active",
        verified_at: new Date(),
      })
      .execute();
    const listed = await inbox.listNotifications(user, null);
    expect(listed.notifications.map((n) => n.url)).toEqual([
      "https://board.example/posts/1",
      "https://board.example/posts/1",
    ]);
    expect(listed.notifications[0].site.url).toBe("https://board.example");

    // One notification deleted: gone from the inbox and the badge; deleting it
    // again, or an id that is not the account's, answers the same.
    const [newest, older] = listed.notifications;
    expect(await inbox.deleteNotification(user, newest.id)).toEqual({ unread: 1 });
    expect((await inbox.listNotifications(user, null)).notifications.map((n) => n.id)).toEqual([older.id]);
    expect(await inbox.deleteNotification(user, newest.id)).toEqual({ unread: 1 });
    await expect(inbox.deleteNotification(user, "not-an-id")).rejects.toMatchObject({ status: 400 });

    expect(await inbox.markRead(user, { all: true })).toEqual({ unread: 0 });

    // Muted: forgotten, and nothing more arrives.
    await inbox.setSiteState(user, "app-site", { state: "muted" });
    queue("0199f2a4-0000-7000-8000-000000000003", "셋째 알림");
    expect(await deliverAppNotifications(sender)).toMatchObject({ stored: 0, pushed: 0 });
    expect((await inbox.listNotifications(user, null)).notifications).toEqual([]);

    // Signing out stops pushes to the device it registered.
    await tokens.revokeAppToken(user.tokenId);
    expect(
      await db.selectFrom("app_devices").selectAll().where("token", "=", "ab".repeat(32)).execute(),
    ).toEqual([]);
  });

  test("hides a site from an account, and takes reports of it", async () => {
    const { token } = await tokens.exchangeCode({ ...(await signIn()), verifier });
    const user = (await tokens.appTokenUser(token))!;
    await inbox.setSiteState(user, "app-site", { state: "allowed" });
    const names = async (id?: string) =>
      (await showcasePage(1, id)).sites.map((site) => site.name);
    expect(await names(user.id)).toContain("app-site");

    // Hidden: gone from its showcase, its sites and its inbox, and what the
    // site sends it is dropped; everyone else still sees the site.
    await moderation.hideSite(user, "app-site");
    expect(await names(user.id)).not.toContain("app-site");
    expect(await names()).toContain("app-site");
    expect((await inbox.listSites(user)).sites).toEqual([]);
    expect((await moderation.listHiddenSites(user)).sites).toMatchObject([
      { site: { name: "app-site" } },
    ]);
    outboxes.set("app-site", [
      {
        id: "0199f2a4-0000-7000-8000-000000000009",
        members: [memberId],
        title: "숨긴 사이트의 알림",
        body: "",
        path: "/",
        at: Date.now(),
      },
    ]);
    const sender = { send: async () => "delivered" as const, close() {} };
    expect(await deliverAppNotifications(sender)).toMatchObject({ stored: 0, pushed: 0 });

    // Shown again.
    await moderation.showSite(user, "app-site");
    expect(await names(user.id)).toContain("app-site");
    expect((await moderation.listHiddenSites(user)).sites).toEqual([]);

    // A signed-in report hides the site for the reporter; a signed-out one is
    // kept by address. Reports are limited an hour.
    expect(
      await moderation.report({ user, ip: null }, { site: "app-site", reason: "spam" }),
    ).toEqual({ hidden: true });
    expect(await names(user.id)).not.toContain("app-site");
    expect(
      await moderation.report(
        { user: null, ip: "203.0.113.7" },
        { site: "app-site", reason: "sexual" },
      ),
    ).toEqual({ hidden: false });
    const kept = await db
      .selectFrom("app_reports")
      .select(["reporter_user_id", "reporter_ip", "reason"])
      .where("site_user_id", "=", siteId)
      .orderBy("id")
      .execute();
    expect(kept).toEqual([
      { reporter_user_id: user.id, reporter_ip: null, reason: "spam" },
      { reporter_user_id: null, reporter_ip: "203.0.113.7", reason: "sexual" },
    ]);
    await expect(
      moderation.report({ user: null, ip: null }, { site: "app-site", reason: "spam" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      moderation.report({ user, ip: null }, { site: "app-site", reason: "rude" }),
    ).rejects.toMatchObject({ status: 400 });
    for (let i = 1; i < moderation.REPORTS_PER_HOUR; i++)
      await moderation.report({ user, ip: null }, { site: "app-site", reason: "other" });
    await expect(
      moderation.report({ user, ip: null }, { site: "app-site", reason: "other" }),
    ).rejects.toMatchObject({ status: 429 });
  });

  test("suspends a site: kept, its files moved, without data or notifications", async () => {
    const { token } = await tokens.exchangeCode({ ...(await signIn()), verifier });
    const user = (await tokens.appTokenUser(token))!;
    // Earlier tests left the site reported, so hidden for this account.
    await moderation.showSite(user, "app-site");
    expect((await inbox.listSites(user)).sites).toHaveLength(1);
    const operator = { id: reader, loginName: "app-reader" };
    const site = { id: siteId, login: "app-site" };

    await siteModeration.setSiteModeration(site, "suspended", "불법 촬영물", operator);
    expect(
      await db.selectFrom("site_moderation_actions").select(["level", "reason", "operator_user_id"])
        .where("site_user_id", "=", siteId).execute(),
    ).toEqual([{ level: "suspended", reason: "불법 촬영물", operator_user_id: reader }]);
    // Its files move with the change, by a task queued in the same transaction.
    const quarantines = async () =>
      (
        await sql<{ params: { direction: string; login: string } }>`
          select params from absurd.t_maintenance
          where task_name = 'site-quarantine-v1' and params->>'userId' = ${String(siteId)}
          order by task_id`.execute(db)
      ).rows.map((row) => `${row.params.login} ${row.params.direction}`);
    expect(await quarantines()).toEqual(["app-site in"]);
    // One fixed rule, whatever is suspended.
    expect(siteModeration.quarantineExpression()).toBe(
      `(http.host in {"r2.${process.env.NEXT_PUBLIC_DOMAIN}" "media.naru.pub"} and starts_with(http.request.uri.path, "/_suspended/"))`,
    );
    // Its object answers nothing; the apps no longer show it.
    expect(await databaseEntitledUntil(siteId)).toBe(0);
    expect((await inbox.listSites(user)).sites).toEqual([]);
    expect((await showcasePage(1, user.id)).sites.map((s) => s.name)).not.toContain("app-site");

    // Hidden only: served, out of the listings, nothing blocked.
    await siteModeration.setSiteModeration(site, "hidden", "스팸", operator);
    expect(await quarantines()).toEqual(["app-site in", "app-site out"]);
    expect(await databaseEntitledUntil(siteId)).toBeNull();
    expect((await inbox.listSites(user)).sites).toHaveLength(1);

    await siteModeration.setSiteModeration(site, null, "확인 결과 문제 없음", operator);
    expect(await quarantines()).toHaveLength(2);
    expect((await showcasePage(1)).sites.map((s) => s.name)).toContain("app-site");
  });

  test("pushes starred sites' updates, at most once a day", async () => {
    const { token } = await tokens.exchangeCode({ ...(await signIn()), verifier });
    const user = (await tokens.appTokenUser(token))!;
    await inbox.registerDevice(user, {
      platform: "fcm",
      token: "starred-device-token",
      environment: "production",
      bundleId: "pub.naru",
    });
    const other = (
      await sql<{ id: string }>`insert into users (login_name, password_hash)
        values ('app-starred', 'x') returning id`.execute(db)
    ).rows[0].id;
    ids.push(other);
    // Messages by id: the reader may have devices from earlier tests.
    const messages = new Map<string, { siteTitle: string; body: string; url: string }>();
    const sender = {
      send: async (_: unknown, message: { id: string; siteTitle: string; body: string; url: string }) => {
        messages.set(message.id, message);
        return "delivered" as const;
      },
      close() {},
    };
    const run = async () => {
      messages.clear();
      const totals = await pushStarredUpdates(sender);
      return { totals, messages: [...messages.values()] };
    };
    const update = (id: string, minutesAgo = 0) =>
      db
        .updateTable("users")
        .set({ site_updated_at: new Date(Date.now() - minutesAgo * 60_000) })
        .where("id", "=", id)
        .execute();
    // An earlier test gave app-site a custom domain, which the push opens.
    const origins = await siteOrigins(["app-site", "app-starred"]);
    const origin = (name: string) => origins.get(name)!;
    const host = (name: string) => new URL(origin(name)).host;

    for (const name of ["app-site", "app-starred", "app-reader"])
      await siteStars.starSite(user.id, name);
    // Updated before the star: not news.
    expect((await run()).totals.accounts).toBe(0);

    // The reader's own site is left out.
    await update(siteId);
    await update(reader);
    const first = await run();
    expect(first.totals.accounts).toBe(1);
    expect(first.totals.pushed).toBeGreaterThan(0);
    expect(first.messages).toEqual([
      expect.objectContaining({
        siteTitle: siteLine("앱 게시판", origin("app-site")),
        body: `${host("app-site")}에 새 소식이 있습니다.`,
        url: origin("app-site"),
      }),
    ]);

    // Once a day: a later update waits for tomorrow.
    await update(other);
    expect((await run()).totals.accounts).toBe(0);
    // A day passes: everything so far moves 21 hours back.
    const tomorrow = async () => {
      await sql`update site_stars set notified_at = notified_at - interval '21 hours',
        created_at = created_at - interval '21 hours' where user_id = ${user.id}`.execute(db);
      await sql`update users set site_updated_at = site_updated_at - interval '21 hours'
        where id in (${siteId}, ${other}, ${reader})`.execute(db);
    };
    await tomorrow();
    expect((await run()).messages).toMatchObject([
      { body: `${host("app-starred")}에 새 소식이 있습니다.` },
    ]);

    await tomorrow();
    await update(siteId, 1);
    await update(other);
    expect((await run()).messages).toMatchObject([
      {
        siteTitle: "별표한 사이트 2곳",
        body: `${host("app-starred")}, ${host("app-site")}에 새 소식이 있습니다.`,
      },
    ]);
  });
});
