// Restore points (1.1.0): a site's whole database as `dump` answers it
// (NDJSON, lib/site-data/dump-format.ts), gzip-compressed, kept in R2 under
// `_naru-runtime/<site>/restore-points/` for RESTORE_POINT_DAYS. The site's
// object writes one before a release's migrations run,
// `<generation>.ndjson.gz`, and one before each restore,
// `before-restore-<ms>.ndjson.gz`, so a restore can be undone. Older ones are
// still read: uncompressed `.ndjson`, and, from before NDJSON, `.json`, the
// whole dump as one JSON object. Shared by the edge (site.ts) and the control
// plane.

/** Where a site's restore points are kept. */
export const restorePointsPrefix = (site: string) =>
  `_naru-runtime/${site}/restore-points/`;

const GENERATION =
  /^(([a-f0-9]{8})-([a-f0-9]{4})-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.(?:ndjson\.gz|ndjson|json)$/;
const BEFORE_RESTORE =
  /^before-restore-(\d{1,15})\.(?:ndjson\.gz|ndjson|json)$/;

/** Whether `name` names a restore point: either kind, and nothing else. */
export const restorePointName = (name: unknown): name is string =>
  typeof name === "string" &&
  (GENERATION.test(name) || BEFORE_RESTORE.test(name));

/** Whether a restore point is in the format before NDJSON, one JSON object. */
export const legacyRestorePoint = (name: string) => name.endsWith(".json");

/** Whether a restore point is gzip-compressed NDJSON, as they are written now. */
export const compressedRestorePoint = (name: string) =>
  name.endsWith(".ndjson.gz");

/** The type restore points are stored with: no Content-Encoding, ever. */
export const RESTORE_POINT_CONTENT_TYPE = "application/gzip";

/** The name of the restore point a restore keeps of what it replaces. */
export const beforeRestoreName = (now = Date.now()) =>
  `before-restore-${now}.ndjson.gz`;

/** The name of the restore point kept before a release's migrations. */
export const releaseRestorePointName = (generation: string) =>
  `${generation}.ndjson.gz`;

/** How long a restore point is kept: then `pruneRestorePoints` deletes it. */
export const RESTORE_POINT_DAYS = 7;
export const RESTORE_POINT_KEEP_MS = RESTORE_POINT_DAYS * 24 * 60 * 60 * 1000;

export type RestorePoint = {
  name: string;
  /** When it was made, epoch ms. */
  createdAt: number;
  /** Before a release's migrations, or before a restore. */
  kind: "release" | "before-restore";
  /** The release it preceded (its generation), for a release's. */
  generation: string | null;
};

/**
 * What a restore point's name says about it: when it was made (a UUIDv7's
 * first 48 bits are its milliseconds), and, for a release's, the release it
 * preceded. Null for a name that is not a restore point's.
 */
export function restorePointOf(name: string): RestorePoint | null {
  const release = GENERATION.exec(name);
  if (release)
    return {
      name,
      createdAt: parseInt(release[2] + release[3], 16),
      kind: "release",
      generation: release[1],
    };
  const restore = BEFORE_RESTORE.exec(name);
  if (restore)
    return {
      name,
      createdAt: Number(restore[1]),
      kind: "before-restore",
      generation: null,
    };
  return null;
}

/** What pruning needs of the site bucket: R2's binding, r2-s3.ts, or S3. */
export interface RestorePointBucket {
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: { key: string; uploaded?: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string[]): Promise<unknown>;
}

/** Keys deleted at a time. */
const PRUNE_BATCH = 50;

/**
 * Deletes `site`'s restore points older than RESTORE_POINT_KEEP_MS: a point's
 * age is its name's time (restorePointOf), or, for a name that is not a
 * restore point's, when the object was uploaded. Only keys under the site's
 * `restore-points/` are ever deleted; one whose age cannot be told stays.
 * Returns the names deleted.
 */
export async function pruneRestorePoints(
  bucket: RestorePointBucket,
  site: string,
  now = Date.now(),
): Promise<string[]> {
  const prefix = restorePointsPrefix(site);
  const expired: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const object of page.objects) {
      if (!object.key.startsWith(prefix) || object.key.length === prefix.length)
        continue;
      const name = object.key.slice(prefix.length);
      const createdAt =
        restorePointOf(name)?.createdAt ?? object.uploaded?.getTime();
      if (createdAt !== undefined && now - createdAt > RESTORE_POINT_KEEP_MS)
        expired.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let at = 0; at < expired.length; at += PRUNE_BATCH)
    await bucket.delete(expired.slice(at, at + PRUNE_BATCH));
  return expired.map((key) => key.slice(prefix.length));
}
