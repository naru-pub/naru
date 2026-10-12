import { sql } from "kysely";
import { db } from "@/lib/database";
import { cleanupDeletedMedia } from "@/lib/site-data/media-deletion";

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
  const deleted = await cleanupDeletedMedia();
  console.log(
    `[media-cleanup] Removed ${deleted.removed}/${deleted.attempted} deletions and abandoned uploads`,
  );
}
main().finally(() => db.destroy());
