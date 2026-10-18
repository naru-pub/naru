import { sql, type ExpressionBuilder } from "kysely";
import { pushStarredSiteUpdate } from "@/lib/app-api/starred-updates";
import type { PushSender } from "@/lib/app-api/push";
import { db } from "@/lib/database";
import type { DB } from "@/lib/db";
import { announceSiteUpdate } from "@/lib/federation";

// A site's update, told to whoever follows it: a Create(Note) to its
// fediverse followers (lib/federation.ts) and a push to the Naru app of the
// accounts that starred it (lib/app-api/starred-updates.ts). Run from the
// site-update-dispatcher job (src/cli/dispatch-site-updates.ts) after a
// trailing debounce. A site qualifies when
//
//   1. there's a new edit since it was last told (users.last_activity_sent_at),
//   2. editing has been quiet for QUIET_PERIOD, and
//   3. COOLDOWN_WINDOW has passed since it was last told,
//
// so an update is told at most once a day a site.

const QUIET_PERIOD = sql<Date>`now() - interval '10 minutes'`;
const COOLDOWN_WINDOW = sql<Date>`now() - interval '24 hours'`;

function qualifies(eb: ExpressionBuilder<DB, "users">) {
  return eb.and([
    eb("site_updated_at", "is not", null),
    eb(
      "site_updated_at",
      ">",
      eb.fn.coalesce("last_activity_sent_at", sql<Date>`'epoch'::timestamptz`),
    ),
    eb("site_updated_at", "<", QUIET_PERIOD),
    eb.or([
      eb("last_activity_sent_at", "is", null),
      eb("last_activity_sent_at", "<", COOLDOWN_WINDOW),
    ]),
  ]);
}

/** Sites whose update is due. */
export async function siteUpdateCandidates() {
  return db
    .selectFrom("users")
    .select(["id", "login_name"])
    .where(qualifies)
    .execute();
}

/**
 * Tells the site's update, if it qualifies. The atomic UPDATE is the
 * authoritative guard, so calling this on a site that doesn't qualify is a
 * safe no-op. Answers whether it was told; one audience failing does not
 * keep it from the other.
 */
export async function dispatchSiteUpdate(
  userId: string,
  sender: PushSender,
): Promise<boolean> {
  const claimed = await db
    .updateTable("users")
    .set({ last_activity_sent_at: sql`now()` })
    .where("id", "=", userId)
    .where(qualifies)
    .returning("login_name")
    .executeTakeFirst();
  if (!claimed) return false;

  try {
    await announceSiteUpdate(userId, claimed.login_name);
  } catch (err) {
    console.error(`[site-updates] ${claimed.login_name}: announce failed`, err);
  }
  try {
    await pushStarredSiteUpdate(userId, sender);
  } catch (err) {
    console.error(`[site-updates] ${claimed.login_name}: push failed`, err);
  }
  return true;
}
