import { sql, type Transaction } from "kysely";
import { db } from "@/lib/database";
import type { DB } from "@/lib/db";
import { MAINTENANCE_QUEUE } from "@/lib/maintenance/jobs";

// A site operators suspended (site-moderation.ts) is not written to: its files
// are moved out of the way (site-quarantine.ts), and nothing its owner does may
// put new ones back until the suspension is lifted. Kept apart from
// site-moderation.ts, which brings Cloudflare and the edge, so every writer
// can ask cheaply.

export const SUSPENDED_MESSAGE =
  "운영 정책에 따라 서비스가 중지된 사이트라 파일을 바꿀 수 없습니다.";

/** Whether operators suspended the account's site. */
export async function siteSuspended(userId: string) {
  const row = await db
    .selectFrom("users")
    .select("site_moderation")
    .where("id", "=", userId)
    .executeTakeFirst();
  return row?.site_moderation === "suspended";
}

/** For the file routes: the response refusing a suspended site, or null. */
export async function refuseSuspendedSite(userId: string) {
  return (await siteSuspended(userId))
    ? Response.json(
        { success: false, message: SUSPENDED_MESSAGE },
        { status: 403 },
      )
    : null;
}

/** The durable task moving a site's files (site-quarantine.ts). */
export const SITE_QUARANTINE_TASK = "site-quarantine-v1";
export const QUARANTINE_PREFIX = "_suspended/";

export type SiteQuarantine = {
  userId: string;
  login: string;
  /** in: to quarantine, at a suspension. out: back, when it is lifted. */
  direction: "in" | "out";
  /** The site_moderation_actions row that asked. */
  actionId: string;
};

/** Queues the move with the moderation change that asks for it. */
export async function enqueueQuarantine(
  tx: Transaction<DB>,
  quarantine: SiteQuarantine,
) {
  await sql`select absurd.spawn_task(${MAINTENANCE_QUEUE}, ${SITE_QUARANTINE_TASK},
    ${JSON.stringify(quarantine)}::jsonb,
    ${JSON.stringify({
      idempotency_key: `site-quarantine:${quarantine.actionId}`,
      retry_strategy: {
        kind: "exponential",
        base_seconds: 60,
        factor: 2,
        max_seconds: 600,
      },
    })}::jsonb)`.execute(tx);
}
