// What a site installed from a template, and the storage bookkeeping that
// applying, installing and updating share: the ETags that tell a file the
// owner changed, backups and putting them back, and telling installs of new
// versions. templates.ts and updates.ts both use it; it uses neither.
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "@/lib/db";
import { getUserHomeDirectory, getUserObjectKey } from "@/lib/site-urls";
import { forEachConcurrently } from "./concurrency";
import { templateFileKey } from "./preview";
import * as storage from "./storage";

// Where applying and updating keep the files they replaced.
export const BACKUP_DIRECTORY = ".backup";

// The site owner's own folder, at the site's root: no template may ship a
// file in it, none is applied into it, and no install, update or disconnect
// writes, backs up or removes one there. What an owner keeps in it outlasts
// every template, and templates may load it (docs/board.md).
export const OWNER_DIRECTORY = "_owner";

/** Whether a site path is in the owner's own folder. */
export const inOwnerDirectory = (path: string) =>
  path === OWNER_DIRECTORY || path.startsWith(`${OWNER_DIRECTORY}/`);

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

/**
 * An install's files as they are now: those still exactly as it wrote them
 * (the template's, which removing it may delete), and those the owner has
 * changed since (theirs, which removing it leaves). Files no longer there are
 * neither.
 */
export async function installFileStates(
  loginName: string,
  install: { target_path: string; files: InstalledFile[] },
): Promise<{ untouched: string[]; changed: string[] }> {
  const present = await siteFiles(loginName, install.target_path);
  const untouched: string[] = [];
  const changed: string[] = [];
  for (const file of install.files) {
    // Never the owner's own, whatever an older install recorded.
    if (!present.has(file.path) || inOwnerDirectory(file.path)) continue;
    if (file.etag !== null && present.get(file.path) === file.etag)
      untouched.push(file.path);
    else changed.push(file.path);
  }
  return { untouched, changed };
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
    // Told of new versions.
    notify: boolean;
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
      notify: install.notify,
      files: JSON.stringify(install.files),
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "template_id", "target_path"]).doUpdateSet({
        version_id: install.versionId,
        notify: install.notify,
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

/**
 * Tells everyone who installed the template and asked to be told (notify)
 * of `versionId`, in the transaction that published it: a board
 * notification each, once however many folders they installed it in. One
 * they have not read yet for an earlier version goes, as this one says more.
 * The author is not told of their own version.
 */
export async function notifyTemplateVersion(
  executor: Kysely<DB> | Transaction<DB>,
  templateId: string,
  versionId: string,
): Promise<void> {
  const told = executor
    .selectFrom("board_template_installs as i")
    .innerJoin("board_templates as t", "t.id", "i.template_id")
    .select("i.user_id")
    .distinct()
    .where("i.template_id", "=", templateId)
    .where("i.notify", "=", true)
    .where("i.version_id", "<>", versionId)
    .whereRef("i.user_id", "<>", "t.user_id");
  await executor
    .deleteFrom("board_notifications")
    .where("reason", "=", "template_version")
    .where("read_at", "is", null)
    .where("user_id", "in", told)
    .where("version_id", "in", (eb) =>
      eb
        .selectFrom("board_template_versions")
        .select("id")
        .where("template_id", "=", templateId)
        .where("id", "<>", versionId),
    )
    .execute();
  await executor
    .insertInto("board_notifications")
    .columns(["user_id", "reason", "version_id"])
    .expression(
      told.select([
        sql<"template_version">`'template_version'`.as("reason"),
        sql<string>`${versionId}::uuid`.as("version_id"),
      ]),
    )
    .onConflict((oc) =>
      oc
        .columns(["user_id", "version_id"])
        .where("version_id", "is not", null)
        .doNothing(),
    )
    .execute();
}
