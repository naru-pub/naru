import { sql } from "kysely";
import type { TaskContext } from "absurd-sdk";
import { db } from "@/lib/database";
import { callSiteObject } from "@/lib/edge/client";
import { MAINTENANCE_QUEUE } from "@/lib/maintenance/jobs";
import { deleteMedia } from "./media-deletion";
import { DataError } from "./validation";

// Uploads a site function deleted with ctx.media.delete(). The function only
// queues them, in its site's object and in the same transaction as its other
// writes, since the files and their records live outside that object. Once a
// call commits with uploads queued, this task deletes them the way an owner
// deletion does, then tells the object they are gone. A queue whose task never
// ran (the control plane stopped between the two) is drained by the next call
// on the site that leaves anything queued.

export const MEDIA_RELEASE_TASK = "site-media-release-v1";

/** Starts draining `site`'s queue; calls within a minute share one task. */
export async function queueMediaRelease(site: string) {
  const minute = Math.floor(Date.now() / 60_000);
  await sql`select absurd.spawn_task(${MAINTENANCE_QUEUE}, ${MEDIA_RELEASE_TASK}, ${JSON.stringify({ site })}::jsonb,
    ${JSON.stringify({ idempotency_key: `media-release:${site}:${minute}`, retry_strategy: { kind: "exponential", base_seconds: 60, factor: 2, max_seconds: 600 } })}::jsonb)`.execute(
    db,
  );
}

export async function runMediaRelease(
  { site }: { site: string },
  ctx: Pick<TaskContext, "step">,
) {
  for (let round = 0; ; round++) {
    const remaining = await ctx.step(`release-${round}`, async () => {
      const owner = await db
        .selectFrom("users")
        .select("id")
        .where("login_name", "=", site)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      // A deleted account's media goes with the account.
      if (!owner) return 0;
      const ids = await callSiteObject<string[]>(site, "mediaReleases", {
        limit: 100,
      });
      if (!ids.length) return 0;
      for (const id of ids)
        try {
          await deleteMedia(owner.id, id);
        } catch (error) {
          // Marked deleted already; the media cleanup job retries storage.
          if (!(error instanceof DataError && error.status === 503))
            throw error;
        }
      return callSiteObject<number>(site, "releasedMedia", { ids });
    });
    if (!remaining) return;
  }
}
