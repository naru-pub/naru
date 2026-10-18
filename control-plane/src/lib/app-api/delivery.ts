import { sql } from "kysely";
import { db } from "@/lib/database";
import {
  answerOf,
  callSiteObject,
  requestWorker,
  siteDataWorker,
} from "@/lib/edge/client";
import { unreadCount } from "./inbox";
import { pageUrl, siteOrigins } from "./sites";
import { pushSender, type PushSender } from "./push";

// The app-notifications job (every minute): what sites queued with
// ctx.notify reaches the accounts behind the members they named.
//
// For each site the Worker reports pending (edge/src/notify.ts), its outbox
// is read oldest first. Each member id is resolved to its account through
// site_members (approved members of that site, accounts not deleted); a site
// never learns who has the app. Then, per account and that site:
//
// - no consent row: one is made, pending; the notification is stored, shown
//   once the account allows the site, and not pushed;
// - pending: stored, not pushed;
// - allowed: stored and pushed to the account's devices;
// - muted, or hidden by the account (moderation.ts): dropped.
//
// Rows are stored with their outbox id, so a run that stores and then fails
// to acknowledge stores nothing twice on the next. A site past
// SITE_HOURLY_LIMIT, deleted, or turned off by the operators
// (users.app_notifications_disabled) has its outbox dropped.

/** Notifications a site may have stored in an hour, all recipients counted. */
export const SITE_HOURLY_LIMIT = 1000;
const OUTBOX_BATCH = 100;
/** Batches read per site a run, so one busy site does not hold up the rest. */
const BATCHES_PER_RUN = 10;

interface OutboxRow {
  id: string;
  members: string[];
  title: string;
  body: string;
  path: string;
  at: number;
}

export async function deliverAppNotifications(
  sender: PushSender = pushSender(),
) {
  const { sites } = await answerOf<{ sites: string[] }>(
    await requestWorker(
      siteDataWorker(),
      "/v1/notifications/pending",
      "queued notifications",
      { body: "{}", contentType: "application/json" },
    ),
    "queued notifications",
  );
  const totals = { sites: sites.length, stored: 0, pushed: 0 };
  try {
    for (const site of sites) {
      try {
        const { stored, pushed } = await deliverSite(site, sender);
        totals.stored += stored;
        totals.pushed += pushed;
      } catch (error) {
        console.error(`[app-notifications] ${site}:`, error);
      }
    }
  } finally {
    sender.close();
  }
  return totals;
}

async function deliverSite(name: string, sender: PushSender) {
  const totals = { stored: 0, pushed: 0 };
  for (let batch = 0; batch < BATCHES_PER_RUN; batch++) {
    const rows = await callSiteObject<OutboxRow[]>(name, "notifyOutbox", {
      limit: OUTBOX_BATCH,
    });
    if (!rows.length) {
      // Takes the site off the Worker's pending list.
      await callSiteObject(name, "ackNotifyOutbox", { ids: [] });
      break;
    }
    const site = await db
      .selectFrom("users")
      .select(["id", "login_name", "site_title", "app_notifications_disabled"])
      .where("login_name", "=", name)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const toPush: { userId: string; id: string; row: OutboxRow }[] = [];
    if (site && !site.app_notifications_disabled)
      for (const row of rows) {
        const stored = await storeNotification(site.id, row);
        totals.stored += stored.length;
        for (const entry of stored)
          if (entry.allowed) toPush.push({ ...entry, row });
      }
    await callSiteObject(name, "ackNotifyOutbox", {
      ids: rows.map((row) => row.id),
    });
    const origin = site
      ? (await siteOrigins([site.login_name])).get(site.login_name)!
      : "";
    if (site)
      for (const { userId, id, row } of toPush)
        totals.pushed += await push(sender, userId, {
          id,
          site: site.login_name,
          siteTitle: site.site_title || site.login_name,
          title: row.title,
          body: row.body,
          url: pageUrl(origin, row.path),
        });
    if (rows.length < OUTBOX_BATCH) break;
  }
  return totals;
}

/** One outbox row, for each account it reaches; answers what was newly stored. */
async function storeNotification(siteUserId: string, row: OutboxRow) {
  return db.transaction().execute(async (tx) => {
    const recent = await tx
      .selectFrom("app_notifications")
      .select(sql<number>`count(*)::int`.as("count"))
      .where("site_user_id", "=", siteUserId)
      .where("created_at", ">", new Date(Date.now() - 60 * 60 * 1000))
      .executeTakeFirstOrThrow();
    const room = Math.max(0, SITE_HOURLY_LIMIT - recent.count);
    if (!room || !row.members.length) return [];
    const accounts = await tx
      .selectFrom("site_members as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .leftJoin("app_site_consents as c", (join) =>
        join
          .onRef("c.user_id", "=", "m.user_id")
          .on("c.site_user_id", "=", siteUserId),
      )
      .select(["m.user_id", "c.state"])
      .where("m.site_user_id", "=", siteUserId)
      .where("m.status", "=", "approved")
      // An account that hid the site gets nothing from it (moderation.ts).
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("app_hidden_sites as h")
              .select("h.id")
              .whereRef("h.user_id", "=", "m.user_id")
              .where("h.site_user_id", "=", siteUserId),
          ),
        ),
      )
      .where("m.id", "in", row.members)
      .where("u.deleted_at", "is", null)
      .orderBy("m.id")
      .limit(room)
      .execute();
    const stored: { userId: string; id: string; allowed: boolean }[] = [];
    for (const account of accounts) {
      if (account.state === "muted") continue;
      if (account.state === null)
        await tx
          .insertInto("app_site_consents")
          .values({
            user_id: account.user_id,
            site_user_id: siteUserId,
            state: "pending",
          })
          .onConflict((conflict) =>
            conflict.columns(["user_id", "site_user_id"]).doNothing(),
          )
          .execute();
      const inserted = await tx
        .insertInto("app_notifications")
        .values({
          user_id: account.user_id,
          site_user_id: siteUserId,
          outbox_id: row.id,
          title: row.title,
          body: row.body,
          path: row.path,
        })
        .onConflict((conflict) =>
          conflict.columns(["outbox_id", "user_id"]).doNothing(),
        )
        .returning("id")
        .executeTakeFirst();
      if (inserted)
        stored.push({
          userId: account.user_id,
          id: inserted.id,
          allowed: account.state === "allowed",
        });
    }
    return stored;
  });
}

/** To each of the account's devices; dead tokens are forgotten. Answers how many took it. */
async function push(
  sender: PushSender,
  userId: string,
  message: Omit<Parameters<PushSender["send"]>[1], "badge">,
) {
  const devices = await db
    .selectFrom("app_devices as d")
    .innerJoin("app_tokens as t", "t.id", "d.app_token_id")
    .select(["d.platform", "d.token", "d.environment", "d.bundle_id"])
    .where("t.user_id", "=", userId)
    .execute();
  if (!devices.length) return 0;
  const badge = await unreadCount(userId);
  let delivered = 0;
  for (const device of devices) {
    const result = await sender.send(device, { ...message, badge });
    if (result === "delivered") delivered += 1;
    if (result === "gone")
      await db
        .deleteFrom("app_devices")
        .where("token", "=", device.token)
        .execute();
  }
  return delivered;
}
