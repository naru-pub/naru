// Restore points (1.1.0): a site's whole database as `dump` answers it
// (NDJSON, lib/site-data/dump-format.ts), kept in R2 under
// `_naru-runtime/<site>/restore-points/`. The site's object writes one before
// a release's migrations run, `<generation>.ndjson`, and one before each
// restore, `before-restore-<ms>.ndjson`, so a restore can be undone. Those
// written before NDJSON end in `.json` and hold the whole dump as one JSON
// object: they are listed and restored too. Shared by the edge (site.ts) and
// the control plane.

/** Where a site's restore points are kept. */
export const restorePointsPrefix = (site: string) =>
  `_naru-runtime/${site}/restore-points/`;

const GENERATION =
  /^(([a-f0-9]{8})-([a-f0-9]{4})-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.(nd)?json$/;
const BEFORE_RESTORE = /^before-restore-(\d{1,15})\.(nd)?json$/;

/** Whether `name` names a restore point: either kind, and nothing else. */
export const restorePointName = (name: unknown): name is string =>
  typeof name === "string" &&
  (GENERATION.test(name) || BEFORE_RESTORE.test(name));

/** Whether a restore point is in the format before NDJSON, one JSON object. */
export const legacyRestorePoint = (name: string) => !name.endsWith(".ndjson");

/** The name of the restore point a restore keeps of what it replaces. */
export const beforeRestoreName = (now = Date.now()) =>
  `before-restore-${now}.ndjson`;

/** The name of the restore point kept before a release's migrations. */
export const releaseRestorePointName = (generation: string) =>
  `${generation}.ndjson`;

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
