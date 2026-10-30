// Keeping the templates a site installed up to date: listing them, working
// out what an update would change, and doing it all or nothing.
//
// An update changes only what the template installed. A file whose ETag is
// still the one the install recorded is the template's to replace or
// delete; one the owner changed since is backed up before it is replaced,
// and kept where the new version drops it; the site's other files are never
// touched. If Naru refuses the new site code, every file goes back.
import { sql } from "kysely";
import type { User } from "@/lib/auth";
import { db, recordSiteEdit } from "@/lib/database";
import { getUserObjectKey } from "@/lib/site-urls";
import { SUSPENDED_MESSAGE, siteSuspended } from "@/lib/site-suspension";
import type { License } from "./constants";
import { BoardError } from "./board-error";
import { forEachConcurrently } from "./concurrency";
import {
  BACKUP_DIRECTORY,
  OWNER_DIRECTORY,
  inOwnerDirectory,
  backUp,
  backupStamp,
  installFileStates,
  installedFiles,
  putBack,
  recordInstall,
  siteFiles,
  type InstalledFile,
} from "./installs";
import { templateFileKey } from "./preview";
import { isMigration } from "./site-code";
import { withSiteLock } from "./site-lock";
import * as storage from "./storage";
import { assertCanUseTemplate } from "@/lib/market/access";

export interface InstallSummary {
  id: string;
  templateId: string;
  postId: string;
  title: string;
  slug: string;
  author: string;
  license: License;
  targetPath: string;
  // Told of new versions; when not, they are not offered here either.
  notify: boolean;
  version: { id: string; version: number; siteCode: boolean };
  // The newest version, when it is newer than the installed one and the
  // install is told of new versions.
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
      "i.notify",
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
    notify: row.notify,
    version: {
      id: row.version_id,
      version: row.version,
      siteCode: row.site_code,
    },
    latest:
      row.latest_id &&
      row.latest_version !== null &&
      row.latest_version > row.version &&
      row.notify &&
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

/**
 * For the navigation: whether `userId` installed any template, and how many of
 * their installs have a newer version waiting (those told of new versions).
 */
export async function installCounts(
  userId: string,
): Promise<{ installed: number; updatable: number }> {
  const row = await db
    .selectFrom("board_template_installs as i")
    .innerJoin("board_templates as t", "t.id", "i.template_id")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .innerJoin("board_template_versions as v", "v.id", "i.version_id")
    .leftJoin(
      "board_template_versions as latest",
      "latest.id",
      "t.latest_version_id",
    )
    .select([
      sql<number>`count(*)::int`.as("installed"),
      sql<number>`(count(*) filter (where latest.version > v.version and i.notify and p.deleted_at is null))::int`.as(
        "updatable",
      ),
    ])
    .where("i.user_id", "=", userId)
    .executeTakeFirstOrThrow();
  return { installed: row.installed, updatable: row.updatable };
}

/**
 * For the developer portal: the templates `userId` published, newest first,
 * with their latest version.
 */
export async function authoredTemplates(userId: string): Promise<
  {
    postId: string;
    title: string;
    version: number | null;
  }[]
> {
  return db
    .selectFrom("board_templates as t")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .leftJoin("board_template_versions as v", "v.id", "t.latest_version_id")
    .select(["p.id as postId", "p.title", "v.version"])
    .where("t.user_id", "=", userId)
    .where("p.deleted_at", "is", null)
    .orderBy("p.created_at", "desc")
    .execute();
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
      "i.notify",
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
  await assertCanUseTemplate(user.id, install.template_id);
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

  // A version published before the owner's folder was reserved may hold
  // files that would land in it.
  const intoOwner = newFiles.find((file) =>
    inOwnerDirectory(`${target}${file.path}`),
  );
  if (intoOwner) {
    throw new BoardError(
      409,
      `이 버전에는 사이트 주인의 ${OWNER_DIRECTORY}/ 폴더에 들어갈 파일(${intoOwner.path})이 있어서 업데이트할 수 없어요.`,
    );
  }
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
    // Never the owner's own, whatever an older install recorded.
    if (kept.has(path) || !present.has(path) || inOwnerDirectory(path))
      continue;
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
 * How far an update has got, for the page to show: backing up the files it
 * replaces or deletes, copying the new version's files in, deleting the
 * dropped ones, publishing the site's code.
 */
export type UpdateProgress = {
  phase: "backup" | "copy" | "remove" | "code";
  done: number;
  total: number;
};

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
  onProgress: (progress: UpdateProgress) => void = () => {},
): Promise<UpdateResult> {
  if (await siteSuspended(user.id))
    throw new BoardError(403, SUSPENDED_MESSAGE);
  return await withSiteLock(user.id, () =>
    updateLocked(user, installId, versionId, onProgress),
  );
}

async function updateLocked(
  user: User,
  installId: string,
  versionId: string | undefined,
  report: (progress: UpdateProgress) => void,
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
  if (backupPath) {
    let done = 0;
    report({ phase: "backup", done, total: replaced.length });
    await backUp(user.loginName, backupPath, replaced, () =>
      report({ phase: "backup", done: ++done, total: replaced.length }),
    );
  }

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
  const copying = sources.filter((file) =>
    writing.has(`${install.target_path}${file.path}`),
  );
  try {
    report({ phase: "copy", done: 0, total: copying.length });
    await forEachConcurrently(copying, async (file) => {
      const path = `${install.target_path}${file.path}`;
      await storage.copyObject(
        templateFileKey(install.template_id, plan.to.version, file.path),
        getUserObjectKey(user.loginName, path),
        file.content_type,
      );
      written.push(path);
      report({ phase: "copy", done: written.length, total: copying.length });
    });
    if (deleted.length > 0) {
      report({ phase: "remove", done: 0, total: 1 });
      await storage.deleteObjects(
        deleted.map((path) => getUserObjectKey(user.loginName, path)),
      );
    }
    // Publishes the site's code when it changed; Naru may refuse it.
    if (plan.to.siteCode) report({ phase: "code", done: 0, total: 1 });
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
      notify: install.notify,
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

/** Whether `installId` is told of new versions. */
export async function setInstallNotify(
  user: User,
  installId: string,
  value: unknown,
): Promise<void> {
  if (typeof value !== "boolean") {
    throw new BoardError(400, "새 버전 알림 설정이 올바르지 않습니다.");
  }
  const result = await db
    .updateTable("board_template_installs")
    .set({ notify: value, updated_at: sql`now()` })
    .where("id", "=", installId)
    .where("user_id", "=", user.id)
    .executeTakeFirst();
  if (!result.numUpdatedRows) {
    throw new BoardError(404, "설치한 템플릿을 찾을 수 없어요.");
  }
}

/**
 * How far removing a template's files has got, for the page to show:
 * backing them up, removing them, publishing the site's code without them.
 */
export type DisconnectProgress = {
  phase: "backup" | "remove" | "code";
  done: number;
  total: number;
};

export interface DisconnectResult {
  // The template's files removed, and where they were kept first.
  removed: number;
  backupPath: string | null;
  // Files the owner changed, left in place.
  kept: number;
  // Its site code migrations, left in place: they have run, and a site's
  // migrations are its database's history.
  migrations: number;
}

/**
 * Forgets an install, so it is no longer told of new versions (and another
 * template's site code may then be installed). Its files stay, now the
 * owner's own, unless `removeFiles`: then the files still exactly as the
 * template wrote them go, backed up first, and those the owner changed stay,
 * as do its migrations (Naru refuses a release without one that has run).
 * If Naru refuses the site's code without them, they all go back and the
 * install stays. The site's database is left as it is.
 */
export async function disconnectInstall(
  user: User,
  installId: string,
  {
    removeFiles = false,
    onProgress: report = () => {},
  }: {
    removeFiles?: boolean;
    onProgress?: (progress: DisconnectProgress) => void;
  } = {},
): Promise<DisconnectResult> {
  if (!removeFiles) {
    await forgetInstall(user, installId);
    return { removed: 0, backupPath: null, kept: 0, migrations: 0 };
  }
  if (await siteSuspended(user.id))
    throw new BoardError(403, SUSPENDED_MESSAGE);
  return await withSiteLock(user.id, async () => {
    const install = await loadInstall(user, installId);
    const states = await installFileStates(user.loginName, install);
    const untouched = states.untouched.filter((path) => !isMigration(path));
    const migrations = states.untouched.length - untouched.length;
    const changed = states.changed;
    const backupPath =
      untouched.length > 0
        ? `${BACKUP_DIRECTORY}/${backupStamp(new Date())}/`
        : null;
    if (backupPath) {
      let done = 0;
      report({ phase: "backup", done, total: untouched.length });
      await backUp(user.loginName, backupPath, untouched, () =>
        report({ phase: "backup", done: ++done, total: untouched.length }),
      );
      try {
        report({ phase: "remove", done: 0, total: 1 });
        await storage.deleteObjects(
          untouched.map((path) => getUserObjectKey(user.loginName, path)),
        );
        // Publishes the site's code without the removed files, when they
        // were some of it; Naru may refuse what is left.
        report({ phase: "code", done: 0, total: 1 });
        await storage.purgeSiteFiles(user.loginName, untouched);
      } catch (error) {
        await putBack(user.loginName, {
          backupPath,
          backedUp: untouched,
          created: [],
        });
        await storage
          .purgeSiteFiles(user.loginName, untouched)
          .catch((cause) => console.error("Purge after putting back", cause));
        const message = error instanceof Error ? error.message : String(error);
        throw new BoardError(
          422,
          `템플릿 파일을 지우지 못해서 그대로 두었어요: ${message.slice(0, 300)}`,
        );
      }
    }
    await forgetInstall(user, installId);
    await recordSiteEdit(user.id);
    return {
      removed: untouched.length,
      backupPath,
      kept: changed.length,
      migrations,
    };
  });
}

async function forgetInstall(user: User, installId: string) {
  const result = await db
    .deleteFrom("board_template_installs")
    .where("id", "=", installId)
    .where("user_id", "=", user.id)
    .executeTakeFirst();
  if (!result.numDeletedRows) {
    throw new BoardError(404, "설치한 템플릿을 찾을 수 없어요.");
  }
}
