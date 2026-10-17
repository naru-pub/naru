import { db } from "@/lib/database";
import { callSiteObject } from "@/lib/edge/client";
import { userHasFeature } from "@/lib/entitlements";
import { DataError } from "@/lib/site-data/validation";
import { FunctionRevisions, routesKey } from "./revisions";
import {
  restorePointName,
  restorePointOf,
  restorePointsPrefix,
  type RestorePoint,
} from "./restore-points";
import { revisionStorage } from "./storage";

// The owner's restore points (restore-points.ts): listed from the bucket the
// release code writes through, and restored by the site's object
// (`restoreFrom`, edge/src/site.ts).

/** How long a restore may take: a whole site is read, kept and written. */
const RESTORE_TIMEOUT_MS = 120_000;

async function siteOf(ownerId: string) {
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
        routes: await new FunctionRevisions(revisionStorage, site).routes(
          restored.revision,
        ),
      }),
    );
  return { saved: restorePointOf(restored.saved), revision: restored.revision };
}
