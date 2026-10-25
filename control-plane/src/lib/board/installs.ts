// What a site installed from a template, and the storage bookkeeping that
// applying, installing and updating share: the ETags that tell a file the
// owner changed, backups and putting them back, and queueing automatic
// updates. templates.ts and updates.ts both use it; it uses neither.
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "@/lib/db";
import { MAINTENANCE_QUEUE } from "@/lib/maintenance/jobs";
import { getUserHomeDirectory, getUserObjectKey } from "@/lib/site-urls";
import { forEachConcurrently } from "./concurrency";
import type { UpdatePreference } from "./constants";
import { templateFileKey } from "./preview";
import * as storage from "./storage";

// Where applying and updating keep the files they replaced.
export const BACKUP_DIRECTORY = ".backup";

/** A file an install wrote: its site path, and its ETag when written. */
export interface InstalledFile {
  path: string;
  etag: string | null;
}

export function backupStamp(now: Date): string {
  // Seoul time, as the people reading the folder name are in Korea.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}${get("minute")}${get("second")}`;
}

/** The site's files under `folder`, by path, with their ETags. */
export async function siteFiles(
  loginName: string,
  folder: string,
): Promise<Map<string, string | null>> {
  const home = `${getUserHomeDirectory(loginName)}/`;
  return new Map(
    (await storage.listObjects(`${home}${folder}`)).map((object) => [
      object.key.slice(home.length),
      object.etag ?? null,
    ]),
  );
}

/** `paths` as they are now in the site, for an install's record. */
export async function installedFiles(
  loginName: string,
  folder: string,
  paths: readonly string[],
): Promise<InstalledFile[]> {
  const present = await siteFiles(loginName, folder);
  return paths.map((path) => ({ path, etag: present.get(path) ?? null }));
}

/**
 * Records the ETags a version's files have in storage, so an install can
 * compare a site's copy with the template's.
 */
export async function recordVersionEtags(
  executor: Kysely<DB> | Transaction<DB>,
  templateId: string,
  version: number,
  versionId: string,
): Promise<void> {
  const prefix = templateFileKey(templateId, version, "");
  for (const object of await storage.listObjects(prefix)) {
    if (!object.etag) continue;
    await executor
      .updateTable("board_template_files")
      .set({ etag: object.etag })
      .where("version_id", "=", versionId)
      .where("path", "=", object.key.slice(prefix.length))
      .execute();
  }
}

/** Saves what a site installed, replacing its earlier install there. */
export async function recordInstall(
  executor: Kysely<DB> | Transaction<DB>,
  install: {
    userId: string;
    templateId: string;
    versionId: string;
    targetPath: string;
    updates: UpdatePreference;
    files: InstalledFile[];
  },
): Promise<string> {
  const row = await executor
    .insertInto("board_template_installs")
    .values({
      user_id: install.userId,
      template_id: install.templateId,
      version_id: install.versionId,
      target_path: install.targetPath,
      updates: install.updates,
      files: JSON.stringify(install.files),
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "template_id", "target_path"]).doUpdateSet({
        version_id: install.versionId,
        updates: install.updates,
        files: JSON.stringify(install.files),
        updated_at: sql`now()`,
      }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Copies each of `paths` into `backupPath`, keeping its place under it, and
 * calls `copied` after each.
 */
export async function backUp(
  loginName: string,
  backupPath: string,
  paths: readonly string[],
  copied: () => void = () => {},
): Promise<void> {
  await forEachConcurrently(paths, async (path) => {
    await storage.copyObject(
      getUserObjectKey(loginName, path),
      getUserObjectKey(loginName, `${backupPath}${path}`),
    );
    copied();
  });
}

/**
 * Undoes a change that failed: the backed-up files go back where they were
 * and the files it created go. Best effort, each file on its own, so one
 * failure does not leave the rest changed.
 */
export async function putBack(
  loginName: string,
  change: { backupPath: string | null; backedUp: string[]; created: string[] },
): Promise<void> {
  await forEachConcurrently(change.backedUp, (path) =>
    storage
      .copyObject(
        getUserObjectKey(loginName, `${change.backupPath}${path}`),
        getUserObjectKey(loginName, path),
      )
      .catch((error) => console.error("Could not restore", path, error)),
  );
  await storage
    .deleteObjects(
      change.created.map((path) => getUserObjectKey(loginName, path)),
    )
    .catch((error) => console.error("Could not remove created files", error));
}

export const TEMPLATE_UPDATE_TASK = "template-update-v1";
export type TemplateUpdate = { installId: string; versionId: string };

/**
 * Queues an update to `versionId` for every install of the template that
 * updates automatically, in the transaction that published the version.
 */
export async function enqueueTemplateUpdates(
  executor: Kysely<DB> | Transaction<DB>,
  templateId: string,
  versionId: string,
): Promise<void> {
  const installs = await executor
    .selectFrom("board_template_installs")
    .select("id")
    .where("template_id", "=", templateId)
    .where("updates", "=", "auto")
    .where("version_id", "<>", versionId)
    .execute();
  for (const install of installs) {
    const update: TemplateUpdate = { installId: install.id, versionId };
    await sql`select absurd.spawn_task(${MAINTENANCE_QUEUE}, ${TEMPLATE_UPDATE_TASK}, ${JSON.stringify(update)}::jsonb,
      ${JSON.stringify({ idempotency_key: `template-update:${install.id}:${versionId}`, max_attempts: 3 })}::jsonb)`.execute(
      executor,
    );
  }
}
