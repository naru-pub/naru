// Restore points (1.1.0): a site's whole database as `dump` answers it, kept
// in R2 under `_naru-runtime/<site>/restore-points/`. The site's object writes
// one before a release's migrations run, named by the release's generation,
// and one before each restore, `before-restore-<ms>.json`, so a restore can
// be undone. Shared by the edge (site.ts) and the control plane.

/** Where a site's restore points are kept. */
export const restorePointsPrefix = (site: string) =>
  `_naru-runtime/${site}/restore-points/`;

const GENERATION =
  /^([a-f0-9]{8})-([a-f0-9]{4})-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;
const BEFORE_RESTORE = /^before-restore-(\d{1,15})\.json$/;

/** Whether `name` names a restore point: either kind, and nothing else. */
export const restorePointName = (name: unknown): name is string =>
  typeof name === "string" &&
  (GENERATION.test(name) || BEFORE_RESTORE.test(name));

/** The name of the restore point a restore keeps of what it replaces. */
export const beforeRestoreName = (now = Date.now()) =>
  `before-restore-${now}.json`;

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
      createdAt: parseInt(release[1] + release[2], 16),
      kind: "release",
      generation: name.slice(0, -".json".length),
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
