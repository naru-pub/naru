// Keeping the templates a site installed up to date: listing them, working
// out what an update would change, and doing it all or nothing.
//
// An update changes only what the template installed. A file whose ETag is
// still the one the install recorded is the template's to replace or
// delete; one the owner changed since is backed up before it is replaced,
// and kept where the new version drops it; the site's other files are never
// touched. If Naru refuses the new site code, every file goes back.
import { sql } from "kysely";
import type { TaskContext } from "absurd-sdk";
import type { User } from "@/lib/auth";
import { db, recordSiteEdit } from "@/lib/database";
import { getUserObjectKey } from "@/lib/site-urls";
import { SUSPENDED_MESSAGE, siteSuspended } from "@/lib/site-suspension";
import {
  isUpdatePreference,
  type License,
  type UpdatePreference,
} from "./constants";
import { BoardError } from "./board-error";
import { forEachConcurrently } from "./concurrency";
import {
  BACKUP_DIRECTORY,
  backUp,
  backupStamp,
  installedFiles,
  putBack,
  recordInstall,
  siteFiles,
  type InstalledFile,
  type TemplateUpdate,
} from "./installs";
import { templateFileKey } from "./preview";
import { withSiteLock } from "./site-lock";
import * as storage from "./storage";

export interface InstallSummary {
  id: string;
  templateId: string;
  postId: string;
  title: string;
  slug: string;
  author: string;
  license: License;
  targetPath: string;
  updates: UpdatePreference;
  version: { id: string; version: number; siteCode: boolean };
  // The newest version, when it is newer than the installed one.
  latest: {
    id: string;
    version: number;
    changelog: string | null;
    createdAt: Date;
  } | null;
  deleted: boolean;
  updatedAt: Date;
}

/** The templates `user` installed, newest change first. */
export async function listInstalls(user: User): Promise<InstallSummary[]> {
  const rows = await db
    .selectFrom("board_template_installs as i")
    .innerJoin("board_templates as t", "t.id", "i.template_id")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .innerJoin("users as author", "author.id", "t.user_id")
    .innerJoin("board_template_versions as v", "v.id", "i.version_id")
    .leftJoin(
      "board_template_versions as latest",
      "latest.id",
      "t.latest_version_id",
    )
    .select([
      "i.id",
      "i.template_id",
      "i.target_path",
      "i.updates",
      "i.updated_at",
      "t.post_id",
      "t.slug",
      "t.license",
      "p.title",
      "p.deleted_at",
      "author.login_name as author",
      "v.version",
      "v.site_code",
      "i.version_id",
      "latest.id as latest_id",
      "latest.version as latest_version",
      "latest.changelog as latest_changelog",
      "latest.created_at as latest_created_at",
    ])
    .where("i.user_id", "=", user.id)
    .orderBy("i.updated_at", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    templateId: row.template_id,
    postId: row.post_id,
    title: row.title,
    slug: row.slug,
    author: row.author,
    license: row.license,
    targetPath: row.target_path,
    updates: row.updates,
    version: {
      id: row.version_id,
      version: row.version,
      siteCode: row.site_code,
    },
    latest:
      row.latest_id &&
      row.latest_version !== null &&
      row.latest_version > row.version &&
      !row.deleted_at
        ? {
            id: row.latest_id,
            version: row.latest_version,
            changelog: row.latest_changelog,
            createdAt: row.latest_created_at!,
          }
        : null,
    deleted: row.deleted_at !== null,
    updatedAt: row.updated_at,
  }));
}

/** `user`'s install of a template, for the template's page. */
export async function findInstall(user: User, templateId: string) {
  return (await listInstalls(user)).find(
    (install) => install.templateId === templateId,
  );
}

async function loadInstall(user: User, installId: string) {
  const install = await db
    .selectFrom("board_template_installs as i")
    .innerJoin("board_template_versions as v", "v.id", "i.version_id")
    .select([
      "i.id",
      "i.template_id",
      "i.target_path",
      "i.updates",
      "i.files",
      "i.version_id",
      "v.version",
    ])
    .where("i.id", "=", installId)
    .where("i.user_id", "=", user.id)
    .executeTakeFirst();
  if (!install) throw new BoardError(404, "설치한 템플릿을 찾을 수 없어요.");
  return install;
}

async function loadTargetVersion(templateId: string, versionId?: string) {
  const version = await db
    .selectFrom("board_template_versions as v")
    .innerJoin("board_templates as t", "t.id", "v.template_id")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .select(["v.id", "v.version", "v.site_code", "v.template_id"])
    .where("v.template_id", "=", templateId)
    .where("p.deleted_at", "is", null)
    .$if(versionId !== undefined, (qb) => qb.where("v.id", "=", versionId!))
    .$if(versionId === undefined, (qb) =>
      qb.whereRef("v.id", "=", "t.latest_version_id"),
    )
    .executeTakeFirst();
  if (!version) throw new BoardError(404, "템플릿 버전을 찾을 수 없어요.");
  return version;
}

export type UpdateAction =
  // New in this version.
  | "create"
  // The template's file, unchanged by the owner: replaced.
  | "update"
  // Changed by the owner since it was installed: backed up, then replaced.
  | "modified"
  // The owner's own file where the new version puts one: backed up, replaced.
  | "overwrite"
  // Dropped by this version, unchanged by the owner: deleted.
  | "delete"
  // Dropped by this version but changed by the owner: left in place.
  | "keep";

export interface UpdatePlan {
  installId: string;
  from: { id: string; version: number };
  to: { id: string; version: number; siteCode: boolean };
  files: { path: string; action: UpdateAction }[];
  // Unchanged files, which the update leaves alone.
  unchanged: number;
  // Site code migrations the new version adds.
  migrations: string[];
  changelogs: { version: number; changelog: string | null }[];
}

/** What updating `installId` to `versionId` (the newest when omitted) does. */
export async function planUpdate(
  user: User,
  installId: string,
  versionId?: string,
): Promise<UpdatePlan> {
  const install = await loadInstall(user, installId);
  const to = await loadTargetVersion(install.template_id, versionId);
  if (to.version <= install.version) {
    throw new BoardError(409, "이미 최신 버전이에요.");
  }
  const target = install.target_path;
  const [newFiles, oldFiles, present, changelogs] = await Promise.all([
    db
      .selectFrom("board_template_files")
      .select(["path", "etag"])
      .where("version_id", "=", to.id)
      .orderBy("path")
      .execute(),
    db
      .selectFrom("board_template_files")
      .select("path")
      .where("version_id", "=", install.version_id)
      .execute(),
    siteFiles(user.loginName, target),
    db
      .selectFrom("board_template_versions")
      .select(["version", "changelog"])
      .where("template_id", "=", install.template_id)
      .where("version", ">", install.version)
      .where("version", "<=", to.version)
      .orderBy("version", "desc")
      .execute(),
  ]);
  const installed = new Map(
    install.files.map((file) => [file.path, file.etag]),
  );
  const ours = (path: string) =>
    installed.has(path) &&
    installed.get(path) !== null &&
    installed.get(path) === present.get(path);

  const files: UpdatePlan["files"] = [];
  let unchanged = 0;
  const kept = new Set<string>();
  for (const file of newFiles) {
    const path = `${target}${file.path}`;
    kept.add(path);
    if (!present.has(path)) files.push({ path, action: "create" });
    else if (file.etag !== null && present.get(path) === file.etag) unchanged++;
    else if (ours(path)) files.push({ path, action: "update" });
    else if (installed.has(path)) files.push({ path, action: "modified" });
    else files.push({ path, action: "overwrite" });
  }
  for (const path of installed.keys()) {
    if (kept.has(path) || !present.has(path)) continue;
    files.push({ path, action: ours(path) ? "delete" : "keep" });
  }

  const before = new Set(
    oldFiles
      .map((file) => file.path)
      .filter((path) => path.startsWith("_naru/migrations/")),
  );
  const migrations = newFiles
    .map((file) => file.path)
    .filter(
      (path) => path.startsWith("_naru/migrations/") && !before.has(path),
    );

  return {
    installId,
    from: { id: install.version_id, version: install.version },
    to: { id: to.id, version: to.version, siteCode: to.site_code },
    files,
    unchanged,
    migrations,
    changelogs,
  };
}

export interface UpdateResult {
  version: number;
  backupPath: string | null;
  written: number;
  deleted: number;
  kept: number;
}

/**
 * Updates `installId` to `versionId`, all or nothing: every file it replaces
 * or deletes is backed up first, and if a file cannot be copied or Naru
 * refuses the new site code they all go back and the files it created go.
 * One application or update runs at a time per site.
 */
export async function applyUpdate(
  user: User,
  installId: string,
  versionId?: string,
): Promise<UpdateResult> {
  if (await siteSuspended(user.id))
    throw new BoardError(403, SUSPENDED_MESSAGE);
  return await withSiteLock(user.id, () =>
    updateLocked(user, installId, versionId),
  );
}

async function updateLocked(
  user: User,
  installId: string,
  versionId?: string,
): Promise<UpdateResult> {
  const plan = await planUpdate(user, installId, versionId);
  const install = await loadInstall(user, installId);
  const replaced = plan.files
    .filter((file) =>
      ["update", "modified", "overwrite", "delete"].includes(file.action),
    )
    .map((file) => file.path);
  const created = plan.files
    .filter((file) => file.action === "create")
    .map((file) => file.path);
  const deleted = plan.files
    .filter((file) => file.action === "delete")
    .map((file) => file.path);
  const backupPath =
    replaced.length > 0
      ? `${BACKUP_DIRECTORY}/${backupStamp(new Date())}/`
      : null;
  if (backupPath) await backUp(user.loginName, backupPath, replaced);

  const sources = await db
    .selectFrom("board_template_files")
    .select(["path", "content_type"])
    .where("version_id", "=", plan.to.id)
    .execute();
  const writing = new Set(
    plan.files
      .filter((file) => !["delete", "keep"].includes(file.action))
      .map((file) => file.path),
  );
  const written: string[] = [];
  const change = { backupPath, backedUp: replaced, created };
  try {
    await forEachConcurrently(
      sources.filter((file) =>
        writing.has(`${install.target_path}${file.path}`),
      ),
      async (file) => {
        const path = `${install.target_path}${file.path}`;
        await storage.copyObject(
          templateFileKey(install.template_id, plan.to.version, file.path),
          getUserObjectKey(user.loginName, path),
          file.content_type,
        );
        written.push(path);
      },
    );
    await storage.deleteObjects(
      deleted.map((path) => getUserObjectKey(user.loginName, path)),
    );
    // Publishes the site's code when it changed; Naru may refuse it.
    await storage.purgeSiteFiles(user.loginName, [...written, ...deleted]);
  } catch (error) {
    await putBack(user.loginName, change);
    await storage
      .purgeSiteFiles(user.loginName, [...written, ...deleted])
      .catch((cause) => console.error("Purge after putting back", cause));
    const message = error instanceof Error ? error.message : String(error);
    throw new BoardError(
      422,
      `v${plan.to.version}로 업데이트하지 못해서 v${plan.from.version} 그대로 두었어요: ${message.slice(0, 300)}`,
    );
  }

  // The template's files now: what it wrote, and what it had that the
  // update left as it was.
  const newPaths = sources.map((file) => `${install.target_path}${file.path}`);
  const files: InstalledFile[] = await installedFiles(
    user.loginName,
    install.target_path,
    newPaths,
  );
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto("board_template_applications")
      .values({ version_id: plan.to.id, user_id: user.id })
      .execute();
    await recordInstall(tx, {
      userId: user.id,
      templateId: install.template_id,
      versionId: plan.to.id,
      targetPath: install.target_path,
      updates: install.updates,
      files,
    });
  });
  await recordSiteEdit(user.id);
  return {
    version: plan.to.version,
    backupPath,
    written: written.length,
    deleted: deleted.length,
    kept: plan.files.filter((file) => file.action === "keep").length,
  };
}

/** How `installId` takes new versions. */
export async function setUpdatePreference(
  user: User,
  installId: string,
  value: unknown,
): Promise<void> {
  if (!isUpdatePreference(value)) {
    throw new BoardError(400, "업데이트 방식이 올바르지 않습니다.");
  }
  const result = await db
    .updateTable("board_template_installs")
    .set({ updates: value, updated_at: sql`now()` })
    .where("id", "=", installId)
    .where("user_id", "=", user.id)
    .executeTakeFirst();
  if (!result.numUpdatedRows) {
    throw new BoardError(404, "설치한 템플릿을 찾을 수 없어요.");
  }
}

/**
 * Forgets an install: its files stay, now the owner's own, and it is no
 * longer updated (another template's site code may then be installed).
 */
export async function disconnectInstall(
  user: User,
  installId: string,
): Promise<void> {
  const result = await db
    .deleteFrom("board_template_installs")
    .where("id", "=", installId)
    .where("user_id", "=", user.id)
    .executeTakeFirst();
  if (!result.numDeletedRows) {
    throw new BoardError(404, "설치한 템플릿을 찾을 수 없어요.");
  }
}

/**
 * An automatic update (installs.ts queues one per install when a version
 * is published). A version that adds migrations waits for its owner, as
 * does one that cannot be applied; a later version is queued on its own.
 */
export async function runTemplateUpdate(
  update: TemplateUpdate,
  ctx: Pick<TaskContext, "step">,
): Promise<void> {
  await ctx.step("update", async () => {
    const row = await db
      .selectFrom("board_template_installs as i")
      .innerJoin("users as u", "u.id", "i.user_id")
      .select([
        "i.updates",
        "u.id",
        "u.login_name",
        "u.created_at",
        "u.email",
        "u.email_verified_at",
        "u.discoverable",
      ])
      .where("i.id", "=", update.installId)
      .where("u.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row || row.updates !== "auto") return null;
    const user: User = {
      id: row.id,
      loginName: row.login_name,
      createdAt: row.created_at,
      email: row.email,
      emailVerifiedAt: row.email_verified_at,
      discoverable: row.discoverable,
    };
    try {
      const plan = await planUpdate(user, update.installId, update.versionId);
      if (plan.migrations.length > 0) return null;
      await applyUpdate(user, update.installId, update.versionId);
    } catch (error) {
      // Already updated, or refused and put back: the owner sees it.
      if (error instanceof BoardError) return null;
      throw error;
    }
    return null;
  });
}
