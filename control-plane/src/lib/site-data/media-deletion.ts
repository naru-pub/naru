import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "kysely";
import { db, requestDeadline } from "@/lib/database";
import { s3Client } from "@/lib/s3";
import { DataError } from "./validation";

export const mediaDeletionStorage = {
  deleteObject(objectKey: string) {
    return s3Client.send(
      new DeleteObjectCommand({
        Bucket: process.env.SITE_DATA_MEDIA_BUCKET || "naru-media",
        Key: objectKey,
      }),
    );
  },
};

/** Durable intent precedes object deletion, so a crashed request can be recovered. */
export async function deleteMedia(
  siteUserId: string,
  id: string,
  memberId?: string,
  uploadedBy?: string | null,
) {
  const file = await db.transaction().execute(async (tx) => {
    await requestDeadline(tx);
    const found = await tx
      .selectFrom("site_data_files")
      .selectAll()
      .where("id", "=", id)
      .where("user_id", "=", siteUserId)
      .forUpdate()
      .executeTakeFirst();
    if (!found) return;
    if (memberId !== undefined && found.member_id !== memberId)
      throw new DataError(
        403,
        "Members can delete only their own uploads.",
        "ACCESS_DENIED",
      );
    if (uploadedBy !== undefined && found.member_id !== uploadedBy)
      throw new DataError(
        403,
        "The file uploader does not match the cleanup request.",
        "ACCESS_DENIED",
      );
    await tx
      .updateTable("site_data_files")
      .where("id", "=", id)
      .set({ deleted_at: found.deleted_at ?? new Date() })
      .execute();
    return found;
  });
  if (!file) return;
  try {
    const startedAt = new Date();
    await mediaDeletionStorage.deleteObject(file.object_key);
    await db
      .updateTable("site_data_files")
      .where("id", "=", id)
      .where("deleted_at", "is not", null)
      .set({ delete_completed_at: startedAt })
      .execute();
  } catch {
    throw new DataError(
      503,
      "Media deletion is queued; storage is unavailable. Retry later.",
      "UNAVAILABLE",
    );
  }
}

/**
 * Keep tombstones for an hour, past every ten-minute presigned PUT and the
 * member upload-limit window. Delete storage again before dropping metadata.
 */
export async function cleanupDeletedMedia() {
  const files = await db
    .selectFrom("site_data_files")
    .select([
      "id",
      "object_key",
      "deleted_at",
      "upload_expires_at",
      "created_at",
    ])
    .where("deleted_at", "is not", null)
    .where((eb) =>
      eb.or([
        eb("delete_completed_at", "is", null),
        sql<boolean>`delete_completed_at < coalesce(upload_expires_at, created_at + interval '1 hour') and coalesce(upload_expires_at, created_at + interval '1 hour') <= now()`,
        eb("deleted_at", "<", sql<Date>`now() - interval '1 hour'`),
      ]),
    )
    .orderBy("deleted_at")
    .limit(1000)
    .execute();
  let removed = 0;
  for (const file of files) {
    try {
      const startedAt = new Date();
      await mediaDeletionStorage.deleteObject(file.object_key);
      const expiry =
        file.upload_expires_at?.getTime() ??
        file.created_at.getTime() + 3600_000;
      if (
        file.deleted_at!.getTime() < Date.now() - 3600_000 &&
        expiry <= startedAt.getTime()
      ) {
        await db
          .deleteFrom("site_data_files")
          .where("id", "=", file.id)
          .where("deleted_at", "is not", null)
          .execute();
        removed++;
      } else {
        await db
          .updateTable("site_data_files")
          .where("id", "=", file.id)
          .set({ delete_completed_at: startedAt })
          .execute();
      }
    } catch (error) {
      console.error(`[media-cleanup] Failed deleting ${file.id}`, error);
    }
  }
  return { removed, attempted: files.length };
}
