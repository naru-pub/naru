import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { TaskContext } from "absurd-sdk";
import { purgeSite, purgeUrls } from "@/lib/cache-purge";
import { db } from "@/lib/database";
import { encodedObjectPath } from "@/lib/edge/file-cache";
import { s3Client } from "@/lib/s3";
import { QUARANTINE_PREFIX, type SiteQuarantine } from "@/lib/site-suspension";
import {
  getSiteBucketUrl,
  getSiteScreenshotKey,
  mediaBucket,
  mediaOrigin,
} from "@/lib/site-urls";

// A suspended site's files (site-moderation.ts) are moved out of the way, so
// the buckets' public hosts, which visitors reach without the edge Worker
// (r2.<domain> for the site bucket, media.<domain> for uploads), no longer
// serve them, however many sites are suspended:
//
//   <login>/...                 → _suspended/<login>/...       (site bucket)
//   _screenshots/<login>.png    → _suspended/_screenshots/<login>.png
//   <userId>/...                → _suspended/<userId>/...      (media bucket)
//
// One fixed Cloudflare rule blocks /_suspended/ on both hosts, and the moved
// files' old addresses are purged from Cloudflare's cache. Lifting the
// suspension moves them back. Nothing is deleted: the files are kept for an
// appeal, or as evidence.
//
// A durable task (Absurd, maintenance queue) does the moving, a page of up to
// 1,000 objects at a time: copy, delete, purge. A page is idempotent, so a
// retried step lists what is left and carries on. Before each page it checks
// the site is still in the state it moves towards, so a lift during a
// suspension's move stops it, and the lift's own task moves everything back.
// Writers refuse a suspended site meanwhile (site-suspension.ts); a media
// upload already signed lands later, so the suspension's task moves media once
// more after every signed upload has expired.

/** Upload URLs live 10 minutes (site-data/media.ts); wait a little longer. */
const LATE_UPLOAD_SECONDS = 11 * 60;
const COPIES_AT_ONCE = 16;

type Area = {
  bucket: string;
  /** The public key prefix, as the site serves it. */
  served: string;
  publicUrl: (key: string) => string;
};

const siteBucket = () => process.env.S3_BUCKET_NAME!;

function areas(login: string, userId: string) {
  const site: Area = {
    bucket: siteBucket(),
    served: `${login}/`,
    publicUrl: (key) => getSiteBucketUrl(encodedObjectPath(key)),
  };
  return {
    site,
    screenshot: { ...site, served: getSiteScreenshotKey(login) },
    media: {
      bucket: mediaBucket(),
      served: `${userId}/`,
      publicUrl: (key: string) => `${mediaOrigin()}/${encodedObjectPath(key)}`,
    } satisfies Area,
  };
}

/** Whether the site is still where this move takes it. */
async function stillWanted(quarantine: SiteQuarantine) {
  const user = await db
    .selectFrom("users")
    .select(["site_moderation", "deleted_at"])
    .where("id", "=", quarantine.userId)
    .executeTakeFirst();
  if (!user || user.deleted_at) return false;
  return (
    (user.site_moderation === "suspended") === (quarantine.direction === "in")
  );
}

/**
 * Moves every object under one prefix to another in the same bucket, a page
 * at a time, purging the served addresses; returns how many moved, or null
 * when the site left the state the move was for.
 */
async function movePrefix(
  quarantine: SiteQuarantine,
  area: Area,
  heartbeat: () => Promise<void>,
) {
  const quarantined = QUARANTINE_PREFIX + area.served;
  const [from, to] =
    quarantine.direction === "in"
      ? [area.served, quarantined]
      : [quarantined, area.served];
  let moved = 0;
  for (;;) {
    if (!(await stillWanted(quarantine))) return null;
    const page = await s3Client.send(
      new ListObjectsV2Command({ Bucket: area.bucket, Prefix: from }),
    );
    const keys = (page.Contents ?? []).map((object) => object.Key!);
    if (!keys.length) return moved;
    for (let i = 0; i < keys.length; i += COPIES_AT_ONCE) {
      await Promise.all(
        keys.slice(i, i + COPIES_AT_ONCE).map((key) =>
          s3Client.send(
            new CopyObjectCommand({
              Bucket: area.bucket,
              CopySource: `${area.bucket}/${encodedObjectPath(key)}`,
              Key: to + key.slice(from.length),
            }),
          ),
        ),
      );
      await heartbeat();
    }
    const deleted = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: area.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      }),
    );
    if (deleted.Errors?.length)
      throw new Error(
        `Quarantine delete failed: ${deleted.Errors[0].Code} ${deleted.Errors[0].Key}`,
      );
    // What Cloudflare kept at the served addresses goes either way: the
    // files leaving, or a 404 cached while they were away.
    const served = keys.map((key) =>
      area.publicUrl(
        quarantine.direction === "in"
          ? key
          : area.served + key.slice(from.length),
      ),
    );
    await purgeUrls(served);
    moved += keys.length;
    await heartbeat();
  }
}

/** The task: moves the site's files, its screenshot and its uploads. */
export async function runSiteQuarantine(
  quarantine: SiteQuarantine,
  ctx: Pick<TaskContext, "step" | "sleepFor" | "heartbeat">,
) {
  const where = areas(quarantine.login, quarantine.userId);
  const heartbeat = () => ctx.heartbeat();
  await ctx.step("site", () => movePrefix(quarantine, where.site, heartbeat));
  await ctx.step("screenshot", () =>
    movePrefix(quarantine, where.screenshot, heartbeat),
  );
  await ctx.step("media", () => movePrefix(quarantine, where.media, heartbeat));
  // The edge's cached pages, which are tagged by site rather than addressed.
  await ctx.step("edge-cache", async () => {
    await purgeSite(quarantine.login);
    return null;
  });
  if (quarantine.direction === "out") return;
  await ctx.sleepFor("late-uploads", LATE_UPLOAD_SECONDS);
  await ctx.step("late-media", () =>
    movePrefix(quarantine, where.media, heartbeat),
  );
}

/** Deletes what a deleted account left in quarantine. */
export async function deleteQuarantined(login: string, userId: string) {
  const where = areas(login, userId);
  for (const area of [where.site, where.screenshot, where.media]) {
    const prefix = QUARANTINE_PREFIX + area.served;
    for (;;) {
      const page = await s3Client.send(
        new ListObjectsV2Command({ Bucket: area.bucket, Prefix: prefix }),
      );
      const keys = (page.Contents ?? []).map((object) => object.Key!);
      if (!keys.length) break;
      const deleted = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: area.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      );
      if (deleted.Errors?.length)
        throw new Error(`Quarantine delete failed: ${deleted.Errors[0].Code}`);
    }
  }
}
