import { sql } from "kysely";
import { db } from "@/lib/database";
import { uuidv7 } from "@/lib/uuid";
import { push } from "./delivery";
import { pushSender, type PushSender } from "./push";
import { siteLine, siteOrigins } from "./sites";

// Starred sites' updates, pushed to the Naru app at most once a day: the
// daily starred-site-updates job (src/cli/push-starred-updates.ts).
//
// An account with a registered device gets one push naming its starred sites
// updated (users.site_updated_at) since it was last told of each
// (site_stars.notified_at), or since the star. Updates older than
// STALE_AFTER are not news: an account that registers a device weeks after
// starring is not told of them. Left out: the account's own site, deleted
// and suspended sites, and accounts told within ONCE_PER, so a rerun or a
// manual run pushes nothing twice.
//
// The push is Naru's, not a site's: it needs no consent (starring is the
// choice), is not stored in the inbox, and carries a fresh id the inbox does
// not know, so the apps marking it read changes nothing. Stars are marked
// told before the push: a push lost to a crash is not sent again.

const STALE_AFTER = sql`interval '2 days'`;
const ONCE_PER = sql`interval '20 hours'`;
/** Sites a push names by address; the rest are counted. */
const NAMED_SITES = 3;
/** APNs' thread-id and FCM's site: the daily pushes group together. */
export const STARRED_THREAD = "naru-starred";

export async function pushStarredUpdates(sender: PushSender = pushSender()) {
  try {
    const rows = await db
      .selectFrom("site_stars as st")
      .innerJoin("users as s", "s.id", "st.site_user_id")
      .innerJoin("users as u", "u.id", "st.user_id")
      .select([
        "st.user_id",
        "st.site_user_id",
        "s.login_name",
        "s.site_title",
        "s.site_updated_at",
      ])
      .where("u.deleted_at", "is", null)
      .where("s.deleted_at", "is", null)
      .where((eb) =>
        eb.or([eb("s.site_moderation", "is", null), eb("s.site_moderation", "!=", "suspended")]),
      )
      .whereRef("st.site_user_id", "!=", "st.user_id")
      .where(
        "s.site_updated_at",
        ">",
        sql<Date>`greatest(coalesce(st.notified_at, st.created_at), now() - ${STALE_AFTER})`,
      )
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("app_devices as d")
            .innerJoin("app_tokens as t", "t.id", "d.app_token_id")
            .select("d.id")
            .whereRef("t.user_id", "=", "st.user_id"),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("site_stars as told")
              .select("told.id")
              .whereRef("told.user_id", "=", "st.user_id")
              .where("told.notified_at", ">", sql<Date>`now() - ${ONCE_PER}`),
          ),
        ),
      )
      .orderBy("st.user_id")
      .orderBy("s.site_updated_at", "desc")
      .execute();

    const byUser = new Map<string, typeof rows>();
    for (const row of rows)
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
    const origins = await siteOrigins([...new Set(rows.map((row) => row.login_name))]);

    const totals = { accounts: byUser.size, pushed: 0 };
    for (const [userId, sites] of byUser) {
      try {
        await db
          .updateTable("site_stars")
          .set({ notified_at: new Date() })
          .where("user_id", "=", userId)
          .where(
            "site_user_id",
            "in",
            sites.map((site) => site.site_user_id),
          )
          .execute();
        totals.pushed += await push(sender, userId, starredMessage(sites, origins));
      } catch (error) {
        console.error(`[starred-updates] ${userId}:`, error);
      }
    }
    return totals;
  } finally {
    sender.close();
  }
}

/** The push for an account's updated starred sites, most recently updated first. */
export function starredMessage(
  sites: { login_name: string; site_title: string | null }[],
  origins: Map<string, string>,
) {
  const origin = (name: string) => origins.get(name)!;
  const hosts = sites.map((site) => new URL(origin(site.login_name)).host);
  const [first] = sites;
  const named = hosts.slice(0, NAMED_SITES).join(", ");
  const rest = hosts.length - NAMED_SITES;
  return {
    id: uuidv7(),
    site: STARRED_THREAD,
    siteTitle:
      sites.length === 1
        ? siteLine(first.site_title, origin(first.login_name))
        : `별표한 사이트 ${sites.length}곳`,
    title: "별표한 사이트 업데이트",
    body: `${rest > 0 ? `${named} 외 ${rest}곳` : named}에 새 소식이 있습니다.`,
    url: origin(first.login_name),
  };
}
