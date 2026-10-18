import { db } from "@/lib/database";
import { callSiteObject } from "@/lib/edge/client";
import { configureEdge } from "@/lib/edge/sync";
import { userHasFeature } from "@/lib/entitlements";
import { recordAllUploads } from "@/lib/site-data/media";
import { DataError } from "@/lib/site-data/validation";
import { publishSiteFunctions } from "./releases";
import { NO_ROUTES } from "./routes";
import { FunctionRevisions, routesKey } from "./revisions";
import {
  restorePointName,
  restorePointOf,
  restorePointsPrefix,
  type RestorePoint,
} from "./restore-points";
import { openRestorePoint, revisionStorage } from "./storage";

// The owner's restore points (restore-points.ts): listed from the bucket the
// release code writes through, and restored by the site's object
// (`restoreFrom`, edge/src/site.ts).

/** How long a restore may take: a whole site is read, kept and written. */
const RESTORE_TIMEOUT_MS = 120_000;
/** How long keeping a restore point may take: a whole site is written. */
const SAVE_TIMEOUT_MS = 120_000;

export async function siteOf(ownerId: string) {
  if (!(await userHasFeature(ownerId, "database")))
    throw new DataError(403, "Database access is not enabled for this site.");
  const user = await db
    .selectFrom("users")
    .select("login_name")
    .where("id", "=", ownerId)
    .executeTakeFirstOrThrow();
  return user.login_name;
}

/** A site's restore points, newest first, with their sizes in bytes. */
export async function listRestorePoints(
  ownerId: string,
): Promise<(RestorePoint & { size: number })[]> {
  const site = await siteOf(ownerId);
  const prefix = restorePointsPrefix(site);
  const points: (RestorePoint & { size: number })[] = [];
  let cursor: string | undefined;
  do {
    const page = await revisionStorage.list({ prefix, cursor });
    for (const object of page.objects) {
      const point = restorePointOf(object.key.slice(prefix.length));
      if (point) points.push({ ...point, size: object.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return points.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Returns the site to the restore point `name`. The object keeps one of the
 * present first and leaves the active release as it is; the routes that
 * release serves are written again for the edge, as activation does
 * (`activateRelease`). Releases purge no cached page, and neither does this.
 */
export async function restoreRestorePoint(ownerId: string, name: unknown) {
  if (!restorePointName(name))
    throw new DataError(400, "Choose a restore point.");
  const site = await siteOf(ownerId);
  const restored = await callSiteObject<{
    revision: string | null;
    saved: string;
  }>(site, "restoreFrom", { name }, undefined, RESTORE_TIMEOUT_MS);
  if (restored.revision)
    await revisionStorage.put(
      routesKey(site),
      JSON.stringify({
        revision: restored.revision,
        ...(await new FunctionRevisions(revisionStorage, site).routes(
          restored.revision,
        )),
      }),
    );
  return { saved: restorePointOf(restored.saved), revision: restored.revision };
}

/**
 * Keeps a restore point of the site now, as the owner asks: the object
 * writes `manual-<ms>.ndjson.gz`, kept the same week as the others, one at
 * a time and a few an hour (`saveRestorePoint`, edge/src/site.ts).
 */
export async function createRestorePoint(ownerId: string) {
  const site = await siteOf(ownerId);
  const saved = await callSiteObject<{ name: string; bytes: number }>(
    site,
    "saveRestorePoint",
    {},
    undefined,
    SAVE_TIMEOUT_MS,
  );
  return { saved: { ...restorePointOf(saved.name)!, size: saved.bytes } };
}

/**
 * A restore point's gzip NDJSON for the owner to download, streamed from R2
 * as it is read, with the file name `<site>-<name>`.
 */
export async function downloadRestorePoint(ownerId: string, name: unknown) {
  if (!restorePointName(name))
    throw new DataError(400, "Choose a restore point.");
  const site = await siteOf(ownerId);
  const object = await openRestorePoint(`${restorePointsPrefix(site)}${name}`);
  if (!object)
    throw new DataError(404, "There is no such restore point.", "NOT_FOUND");
  return { ...object, filename: `${site}-${name}` };
}

/**
 * Empties the site's database, as the owner asks by typing the site's name:
 * a restore point of all of it is kept first (one to undo this with), then
 * every collection, table, applied migration, member role and record of
 * uploads goes (`erase`, edge/src/site.ts). The site's paid status is
 * confirmed to it again, and its _naru code released anew, so its
 * migrations make its tables from nothing. Files, uploads and the site's
 * members on Naru stay. Answers the restore point kept and the release made
 * (null, with its error, when the code was not released).
 */
export async function resetSiteDatabase(
  ownerId: string,
  confirmation: unknown,
) {
  const site = await siteOf(ownerId);
  if (confirmation !== site)
    throw new DataError(
      400,
      "Type the site's name to reset its database.",
      "INVALID_REQUEST",
    );
  const saved = await callSiteObject<{ name: string; bytes: number }>(
    site,
    "saveRestorePoint",
    {},
    undefined,
    SAVE_TIMEOUT_MS,
  );
  await callSiteObject(site, "erase", {});
  await configureEdge(site, ownerId);
  await recordAllUploads(site, ownerId);
  let revision: string | null = null;
  let releaseError: string | null = null;
  try {
    revision = (await publishSiteFunctions(site)).revision;
  } catch (error) {
    if (!(error instanceof DataError)) throw error;
    // Code the release refuses: the site serves files, and routes nothing,
    // until _naru is put right.
    releaseError = error.message;
    await revisionStorage.put(
      routesKey(site),
      JSON.stringify({ revision: null, ...NO_ROUTES }),
    );
  }
  return {
    saved: { ...restorePointOf(saved.name)!, size: saved.bytes },
    revision,
    releaseError,
  };
}
