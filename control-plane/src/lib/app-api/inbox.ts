import { sql } from "kysely";
import { db } from "@/lib/database";
import { DataError } from "@/lib/site-data/validation";
import { appSite, pageUrl, siteOrigins } from "./sites";
import { hiddenSiteIds } from "./moderation";
import type { AppUser } from "./tokens";

// What the app shows a signed-in account: its notifications, the sites that
// sent them and whether each may, and the devices it pushes to.

export const NOTIFICATIONS_PAGE_SIZE = 50;
type ConsentState = "pending" | "allowed" | "muted";

/** Newest first, only from allowed sites; `before` is the last id of the previous page. */
export async function listNotifications(user: AppUser, before: string | null) {
  let query = db
    .selectFrom("app_notifications as n")
    .innerJoin("app_site_consents as c", (join) =>
      join
        .onRef("c.user_id", "=", "n.user_id")
        .onRef("c.site_user_id", "=", "n.site_user_id"),
    )
    .innerJoin("users as s", "s.id", "n.site_user_id")
    .select([
      "n.id",
      "n.title",
      "n.body",
      "n.path",
      "n.created_at",
      "n.read_at",
      "s.login_name",
      "s.site_title",
    ])
    .where("n.user_id", "=", user.id)
    .where("n.site_user_id", "not in", hiddenSiteIds(user.id))
    .where("c.state", "=", "allowed")
    .where("s.deleted_at", "is", null)
    .orderBy("n.id", "desc")
    .limit(NOTIFICATIONS_PAGE_SIZE + 1);
  if (before) {
    if (!UUID.test(before)) throw new DataError(400, "잘못된 페이지입니다.");
    query = query.where("n.id", "<", before);
  }
  const rows = await query.execute();
  const page = rows.slice(0, NOTIFICATIONS_PAGE_SIZE);
  const origins = await siteOrigins(page.map((row) => row.login_name));
  return {
    notifications: page.map((row) => ({
      id: row.id,
      site: appSite(row, origins),
      title: row.title,
      body: row.body,
      url: pageUrl(origins.get(row.login_name)!, row.path),
      createdAt: new Date(row.created_at).toISOString(),
      readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    })),
    next: rows.length > NOTIFICATIONS_PAGE_SIZE ? page[page.length - 1].id : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function markRead(user: AppUser, body: Record<string, unknown>) {
  let update = db
    .updateTable("app_notifications")
    .set({ read_at: new Date() })
    .where("user_id", "=", user.id)
    .where("read_at", "is", null);
  if (body.all !== true) {
    const ids = body.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 500 ||
      !ids.every((id) => typeof id === "string" && UUID.test(id))
    )
      throw new DataError(400, "읽음으로 표시할 알림을 고르지 못했습니다.");
    update = update.where("id", "in", ids as string[]);
  }
  await update.execute();
  return { unread: await unreadCount(user.id) };
}

/** Unread notifications from allowed sites: the badge. */
export async function unreadCount(userId: string) {
  const row = await db
    .selectFrom("app_notifications as n")
    .innerJoin("app_site_consents as c", (join) =>
      join
        .onRef("c.user_id", "=", "n.user_id")
        .onRef("c.site_user_id", "=", "n.site_user_id"),
    )
    .select(sql<number>`count(*)::int`.as("count"))
    .where("n.user_id", "=", userId)
    .where("n.site_user_id", "not in", hiddenSiteIds(userId))
    .where("n.read_at", "is", null)
    .where("c.state", "=", "allowed")
    .executeTakeFirstOrThrow();
  return row.count;
}

const consentFields = [
  "c.state",
  "c.updated_at",
  "s.login_name",
  "s.site_title",
] as const;

function consentOf(
  row: {
    state: ConsentState;
    updated_at: Date | string;
    login_name: string;
    site_title: string | null;
  },
  origins: Map<string, string>,
) {
  return {
    site: appSite(row, origins),
    state: row.state,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Every site that has notified the account, pending first. */
export async function listSites(user: AppUser) {
  const rows = await db
    .selectFrom("app_site_consents as c")
    .innerJoin("users as s", "s.id", "c.site_user_id")
    .select(consentFields)
    .where("c.user_id", "=", user.id)
    .where("c.site_user_id", "not in", hiddenSiteIds(user.id))
    .where("s.deleted_at", "is", null)
    .orderBy(
      sql`case c.state when 'pending' then 0 when 'allowed' then 1 else 2 end`,
    )
    .orderBy("c.updated_at", "desc")
    .execute();
  const origins = await siteOrigins(rows.map((row) => row.login_name));
  return { sites: rows.map((row) => consentOf(row, origins)) };
}

/** Allow or mute a site that has notified the account. */
export async function setSiteState(
  user: AppUser,
  name: string,
  body: Record<string, unknown>,
) {
  const state = body.state;
  if (state !== "allowed" && state !== "muted")
    throw new DataError(400, "허용하거나 끌 수만 있습니다.");
  const site = await db
    .selectFrom("users")
    .select(["id", "login_name", "site_title"])
    .where("login_name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  const updated = site
    ? await db
        .updateTable("app_site_consents")
        .set({ state, updated_at: new Date() })
        .where("user_id", "=", user.id)
        .where("site_user_id", "=", site.id)
        .returning(["state", "updated_at"])
        .executeTakeFirst()
    : undefined;
  // Only sites that have notified the account are listed, so only they change.
  if (!site || !updated) throw new DataError(404, "알림을 보낸 적 없는 사이트입니다.");
  // Muting forgets what the site sent; nothing of it is shown again.
  if (state === "muted")
    await db
      .deleteFrom("app_notifications")
      .where("user_id", "=", user.id)
      .where("site_user_id", "=", site.id)
      .execute();
  return consentOf(
    { ...site, ...updated },
    await siteOrigins([site.login_name]),
  );
}

export async function registerDevice(user: AppUser, body: Record<string, unknown>) {
  const { platform, token, environment, bundleId } = body;
  if (
    (platform !== "apns" && platform !== "fcm") ||
    typeof token !== "string" ||
    !/^[A-Za-z0-9:_.-]{16,4096}$/.test(token) ||
    (environment !== "sandbox" && environment !== "production") ||
    typeof bundleId !== "string" ||
    !/^[A-Za-z0-9.-]{1,200}$/.test(bundleId)
  )
    throw new DataError(400, "기기를 등록하지 못했습니다.");
  // A token moves to whichever sign-in registered it last: one device, one account.
  await db
    .insertInto("app_devices")
    .values({
      app_token_id: user.tokenId,
      platform,
      token,
      environment,
      bundle_id: bundleId,
    })
    .onConflict((conflict) =>
      conflict.column("token").doUpdateSet({
        app_token_id: user.tokenId,
        platform,
        environment,
        bundle_id: bundleId,
        updated_at: new Date(),
      }),
    )
    .execute();
}

export async function removeDevice(user: AppUser, token: string) {
  await db
    .deleteFrom("app_devices")
    .where("token", "=", token)
    .where(
      "app_token_id",
      "in",
      db.selectFrom("app_tokens").select("id").where("user_id", "=", user.id),
    )
    .execute();
}
