import { sql } from "kysely";
import { db } from "@/lib/database";
import { cleanupDeletedMedia } from "@/lib/site-data/media-deletion";
import { callSiteObject } from "@/lib/edge/client";
import { queueMediaRelease } from "@/lib/site-data/media-releases";

/**
 * Managed uploads (1.1.0): each site with any asks its object to queue those
 * no document uses any more, or never did, and drains the queue. Sites are
 * independent: one site's failure is logged and the rest still run.
 */
async function sweepManagedMedia() {
  const sites = await db
    .selectFrom("site_data_files as f")
    .innerJoin("users as u", "u.id", "f.user_id")
    .select("u.login_name")
    .distinct()
    .where("f.managed", "=", true)
    .where("f.deleted_at", "is", null)
    .where("u.deleted_at", "is", null)
    .execute();
  let queued = 0;
  for (const { login_name: site } of sites)
    try {
      const pending = await callSiteObject<number>(site, "sweepMedia", {});
      if (pending) {
        await queueMediaRelease(site);
        queued += 1;
      }
    } catch (error) {
      console.error(
        `[media-cleanup] Sweeping ${site}'s managed media failed`,
        error,
      );
    }
  return { sites: sites.length, queued };
}

async function main() {
  const pending = await db
    .selectFrom("site_data_files")
    .select("id")
    .where("status", "=", "pending")
    .where("deleted_at", "is", null)
    .where("created_at", "<", sql<Date>`now() - interval '1 hour'`)
    .where(
      sql<boolean>`coalesce(upload_expires_at, created_at + interval '1 hour') <= now()`,
    )
    .orderBy("created_at")
    .limit(1000)
    .execute();
  for (const file of pending) {
    // Claim only uploads still pending. A concurrent finalize either wins first
    // or sees this tombstone and cannot revive the file.
    await db
      .updateTable("site_data_files")
      .where("id", "=", file.id)
      .where("status", "=", "pending")
      .where("deleted_at", "is", null)
      .where(
        sql<boolean>`coalesce(upload_expires_at, created_at + interval '1 hour') <= now()`,
      )
      .set({ deleted_at: sql<Date>`created_at` })
      .execute();
  }
  const swept = await sweepManagedMedia();
  console.log(
    `[media-cleanup] Swept ${swept.sites} sites with managed media; ${swept.queued} have uploads to delete`,
  );
  const deleted = await cleanupDeletedMedia();
  console.log(
    `[media-cleanup] Removed ${deleted.removed}/${deleted.attempted} deletions and abandoned uploads`,
  );
}
main().finally(() => db.destroy());
