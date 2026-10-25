// The tables a template version's site code makes, for its post: its
// migrations run on the edge, as a site's would, and the tables SQLite then
// has are kept with the version. Apart from templates.ts, so the jobs
// image's CLIs (template uploads from workflows) can record them too.
import { db } from "@/lib/database";
import { callSiteObject } from "@/lib/edge/client";
import { DataError } from "@/lib/site-data/validation";
import { MIGRATIONS_PREFIX } from "./migrations";
import { templateFileKey } from "./preview";
import * as storage from "./storage";

// The site object template migrations are tried on: no site's, as login
// names cannot start with "_", and empty, as each trial is rolled back.
const TRIAL_SITE = "_template-trial";

/**
 * The tables `migrations` (a template version's, in order) make in an empty
 * site database: run on the edge as a site's are, with its limits and
 * refusals, then rolled back (`trialMigrations`, edge/src/site.ts).
 */
export async function trialTables(
  migrations: { name: string; sql: string }[],
): Promise<string[]> {
  return (
    await callSiteObject<{ tables: string[] }>(TRIAL_SITE, "trialMigrations", {
      migrations,
    })
  ).tables;
}

/**
 * Records the tables a site-code version's migrations make in an empty
 * database (site-code.ts, `trialTables`), for its post to say so. Best
 * effort: one the edge refuses makes none; one tried while the edge is
 * away keeps none yet, and is tried again when its post is next shown.
 */
export async function recordVersionTables(
  versionId: string,
): Promise<string[] | null> {
  const version = await db
    .selectFrom("board_template_versions")
    .select(["template_id", "version", "site_code"])
    .where("id", "=", versionId)
    .executeTakeFirst();
  if (!version?.site_code) return null;
  const files = await db
    .selectFrom("board_template_files")
    .select("path")
    .where("version_id", "=", versionId)
    .where("path", "like", "\\_naru/migrations/%")
    .orderBy("path")
    .execute();
  let tables: string[];
  try {
    const migrations = await Promise.all(
      files.map(async (file) => ({
        name: file.path.slice(MIGRATIONS_PREFIX.length),
        sql:
          (await storage.getText(
            templateFileKey(version.template_id, version.version, file.path),
          )) ?? "",
      })),
    );
    tables = migrations.length > 0 ? await trialTables(migrations) : [];
  } catch (error) {
    // Migrations a site would refuse (422) make nothing; anything else (the
    // edge away, or one without trialMigrations yet) is tried again later.
    if (!(error instanceof DataError) || error.status !== 422) {
      console.error("Trying a template version's migrations", error);
      return null;
    }
    tables = [];
  }
  await db
    .updateTable("board_template_versions")
    .set({ site_tables: JSON.stringify(tables) })
    .where("id", "=", versionId)
    .execute();
  return tables;
}
