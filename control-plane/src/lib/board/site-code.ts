// What a site's database already holds, for installing a template's site
// code over it: the migrations it has run and the tables it has. A site's
// applied migrations are its history (edge/src/site.ts, pendingMigrations):
// a release may not remove or change one, nor add one that sorts before the
// last, so a template's migrations are checked against them before it is
// applied, and the files of those already run are never removed.
import { callSiteObject } from "@/lib/edge/client";
import {
  createRestorePoint,
  eraseSiteDatabase,
  restoreRestorePoint,
} from "@/lib/site-functions/restore";
import { FunctionRevisions, routesKey } from "@/lib/site-functions/revisions";
import { runtimeStorage, siteStorage } from "@/lib/site-functions/storage";

export {
  MIGRATIONS_PREFIX,
  isMigration,
  migrationConflicts,
  migrationDigest,
} from "./migrations";

/**
 * The migrations `site` has run, by name, with their digests: the active
 * release's, every one of which ran when it was activated.
 */
export async function appliedMigrations(
  site: string,
): Promise<Map<string, string>> {
  const routes = await runtimeStorage.get(routesKey(site));
  const revision = routes
    ? (JSON.parse(await routes.text()) as { revision?: string | null }).revision
    : null;
  if (!revision) return new Map();
  const migrations = await new FunctionRevisions(
    siteStorage,
    runtimeStorage,
    site,
  ).migrations(revision);
  return new Map(migrations.map((m) => [m.name, m.digest]));
}

/** The names of `site`'s own tables and views. */
export async function siteTableNames(site: string): Promise<Set<string>> {
  const tables = await callSiteObject<{ name: string }[]>(
    site,
    "siteTables",
    {},
  );
  return new Set(tables.map((table) => table.name.toLowerCase()));
}

/** Keeps a restore point of the site's database now; answers its name. */
export async function saveDatabase(ownerId: string): Promise<string> {
  return (await createRestorePoint(ownerId)).saved.name;
}

/** Empties the site's database, leaving its code (restore.ts). */
export const eraseDatabase = eraseSiteDatabase;

/** Returns the site's database to the restore point `name`. */
export async function restoreDatabase(
  ownerId: string,
  name: string,
): Promise<void> {
  await restoreRestorePoint(ownerId, name);
}
