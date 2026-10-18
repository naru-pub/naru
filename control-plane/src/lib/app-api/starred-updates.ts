import { db } from "@/lib/database";
import { uuidv7 } from "@/lib/uuid";
import { push } from "./delivery";
import type { PushSender } from "./push";
import { siteLine, siteOrigins } from "./sites";

// A site's update, pushed to the Naru app of each account that starred it.
// Sent when federation announces the update (dispatchSiteUpdate in
// lib/federation.ts, from the site-update-dispatcher job), so behind the
// same gate: ten quiet minutes after the last edit, and at most once a day a
// site.
//
// Left out: the site's own account, deleted accounts, and sites deleted,
// suspended or with notifications turned off by the operators
// (users.app_notifications_disabled). The push is Naru's, not a site's: it
// needs no consent (starring is the choice), is not stored in the inbox, and
// carries a fresh id the inbox does not know, so the apps marking it read
// changes nothing.

/** Pushes one site's update to its stargazers; answers how many devices took it. */
export async function pushStarredSiteUpdate(siteUserId: string, sender: PushSender) {
  const site = await db
    .selectFrom("users")
    .select(["login_name", "site_title"])
    .where("id", "=", siteUserId)
    .where("deleted_at", "is", null)
    .where("app_notifications_disabled", "=", false)
    .where((eb) =>
      eb.or([eb("site_moderation", "is", null), eb("site_moderation", "!=", "suspended")]),
    )
    .executeTakeFirst();
  if (!site) return 0;
  const accounts = await db
    .selectFrom("site_stars as st")
    .innerJoin("users as u", "u.id", "st.user_id")
    .select("st.user_id")
    .where("st.site_user_id", "=", siteUserId)
    .where("st.user_id", "!=", siteUserId)
    .where("u.deleted_at", "is", null)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom("app_devices as d")
          .innerJoin("app_tokens as t", "t.id", "d.app_token_id")
          .select("d.id")
          .whereRef("t.user_id", "=", "st.user_id"),
      ),
    )
    .execute();
  if (!accounts.length) return 0;
  const origin = (await siteOrigins([site.login_name])).get(site.login_name)!;
  let pushed = 0;
  for (const { user_id } of accounts)
    pushed += await push(sender, user_id, {
      id: uuidv7(),
      site: site.login_name,
      siteTitle: siteLine(site.site_title, origin),
      title: "별표한 사이트 업데이트",
      body: `${new URL(origin).host}에 새 소식이 있습니다.`,
      url: origin,
    });
  return pushed;
}
