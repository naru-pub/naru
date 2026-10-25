import { db } from "@/lib/database";
import { cleanupDeletedMedia } from "@/lib/site-data/media-deletion";

/**
 * Finishes the media deletions the owner asked for in the media library:
 * removes the stored objects of files already marked deleted, retrying
 * until storage answers. Nothing is deleted on
 * Naru's own judgement: media may be linked from anywhere, so unfinished and
 * unreferenced uploads stay, and the media library shows the latter.
 */
async function main() {
  const deleted = await cleanupDeletedMedia();
  console.log(
    `[media-cleanup] Removed ${deleted.removed}/${deleted.attempted} requested deletions`,
  );
}
main().finally(() => db.destroy());
