import { enqueueTemplatePreview } from "@/lib/maintenance/jobs";
import { sql } from "kysely";
import { db, recordSiteEdit } from "@/lib/database";
import type { User } from "@/lib/auth";
import type { BoardTemplateCollection } from "@/lib/board/template-collections";
import {
  ALLOWED_FILE_EXTENSIONS,
  FILE_EXTENSION_MIMETYPE_MAP,
} from "@/lib/const";
import { getUserFeatures, userHasFeature } from "@/lib/entitlements";
import { assertNoPathTraversal } from "@/lib/file-paths";
import {
  collapseSlashes,
  getUserHomeDirectory,
  getUserObjectKey,
} from "@/lib/site-urls";
import { createCollections, listCollections } from "@/lib/site-data/service";
import { DataError } from "@/lib/site-data/validation";
import {
  APPLICATIONS_PER_HOUR,
  MAX_CHANGELOG_LENGTH,
  MAX_TEMPLATE_SLUG_LENGTH,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_MAX_FILES,
  LICENSES,
  TEMPLATE_SLUG_REGEX,
  GITHUB_REF_REGEX,
  GITHUB_REPOSITORY_REGEX,
  formatBytes,
  hasSiteCode,
  isLicense,
  type License,
  type TemplateSource,
} from "./constants";
import { forEachConcurrently } from "./concurrency";
import { BoardError } from "./errors";
import {
  BACKUP_DIRECTORY,
  backUp,
  backupStamp,
  notifyTemplateVersion,
  installFileStates,
  installedFiles,
  putBack,
  recordInstall,
  recordVersionEtags,
} from "./installs";
import { normalizeGitHubPath } from "./github-source";
import { assertUnderHourlyLimit } from "./limits";
import {
  MIGRATIONS_PREFIX,
  appliedMigrations,
  eraseDatabase,
  isMigration,
  migrationConflicts,
  restoreDatabase,
  saveDatabase,
  siteTableNames,
  trialTables,
} from "./site-code";
import { withSiteLock } from "./site-lock";
import { assertCanPost, validatePostBody, validateTitle } from "./posts";
import {
  getTemplatePreviewUrl,
  templateFileKey,
  templatePrefix,
  templatePreviewUrl,
} from "./preview";
import { clearTemplatePreview, storeTemplatePreview } from "./template-preview";
import * as storage from "./storage";
import { SUSPENDED_MESSAGE, siteSuspended } from "@/lib/site-suspension";
import { uuidv7 } from "@/lib/uuid";

export { BACKUP_DIRECTORY };

// "" is the whole site; anything else is a folder, returned as "a/b/".
export function normalizeFolder(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string")
    throw new BoardError(400, "경로가 올바르지 않습니다.");
  const trimmed = collapseSlashes(value.trim())
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    assertNoPathTraversal(trimmed);
  } catch (error: any) {
    throw new BoardError(400, error.message);
  }
  return `${trimmed}/`;
}

function contentTypeFor(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (!path.includes(".") || !ALLOWED_FILE_EXTENSIONS.includes(extension)) {
    return null;
  }
  return (
    FILE_EXTENSION_MIMETYPE_MAP[
      extension as keyof typeof FILE_EXTENSION_MIMETYPE_MAP
    ] ?? "application/octet-stream"
  );
}

export interface TemplateSourceFile {
  // Relative to the template root.
  path: string;
  key: string;
  size: number;
  contentType: string;
}

// The deepest folder that holds every path, as "a/b/", or "" when the paths
// sit in different places or at the top.
export function commonDirectory(paths: string[]): string {
  if (paths.length === 0) return "";
  let common = paths[0].split("/").slice(0, -1);
  for (const path of paths.slice(1)) {
    const directories = path.split("/").slice(0, -1);
    let shared = 0;
    while (
      shared < common.length &&
      shared < directories.length &&
      common[shared] === directories[shared]
    ) {
      shared++;
    }
    common = common.slice(0, shared);
  }
  return common.length > 0 ? `${common.join("/")}/` : "";
}

// The previous version's files that are still where they were, so the form for
// a new version starts with only those checked. After a folder is renamed or a
// file deleted, the old paths would otherwise stay checked where the picker,
// which lists only what exists, cannot show them to be unchecked.
export async function filesStillPresent(
  loginName: string,
  folder: string,
  paths: string[],
): Promise<string[]> {
  const home = `${getUserHomeDirectory(loginName)}/`;
  const present = new Set(
    (await storage.listObjects(`${home}${folder}`)).map((object) =>
      object.key.slice(home.length),
    ),
  );
  return paths.filter((path) => present.has(path));
}

// The files the author checked, relative to their home directory. The
// template's root is the deepest folder holding all of them, so checking
// hello-world/index.html shares index.html under the root hello-world/.
// Applying it into a new folder then gives that folder's index.html, not
// hello-world/hello-world/index.html. The returned folder is that root.
export async function collectSourceFiles(
  loginName: string,
  paths: string[],
): Promise<{ folder: string; files: TemplateSourceFile[] }> {
  const home = `${getUserHomeDirectory(loginName)}/`;
  const wanted = new Set(paths);
  const files: TemplateSourceFile[] = [];
  for (const object of await storage.listObjects(home)) {
    const path = object.key.slice(home.length);
    if (!wanted.has(path)) continue;
    wanted.delete(path);
    const contentType = contentTypeFor(path);
    if (!contentType) {
      throw new BoardError(
        400,
        `템플릿에 넣을 수 없는 파일 형식입니다: ${path}`,
      );
    }
    files.push({ path, key: object.key, size: object.size, contentType });
  }
  if (wanted.size > 0) {
    throw new BoardError(
      400,
      `파일을 찾을 수 없어요: ${[...wanted].slice(0, 3).join(", ")}`,
    );
  }
  if (files.length === 0) {
    throw new BoardError(400, "공유할 파일을 골라 주세요.");
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > TEMPLATE_MAX_BYTES) {
    throw new BoardError(
      400,
      `템플릿은 ${formatBytes(TEMPLATE_MAX_BYTES)}까지 공유할 수 있어요. (지금 ${formatBytes(total)})`,
    );
  }

  const folder = commonDirectory(files.map((file) => file.path));
  for (const file of files) file.path = file.path.slice(folder.length);
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { folder, files };
}

// The checked files as the request sent them: paths relative to the home
// directory, outside the backups applying templates leaves behind.
function validateSelection(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BoardError(400, "공유할 파일을 골라 주세요.");
  }
  const paths = [...new Set(value as string[])].map((entry) =>
    collapseSlashes(entry).replace(/^\/+/, ""),
  );
  if (paths.length === 0)
    throw new BoardError(400, "공유할 파일을 골라 주세요.");
  if (paths.length > TEMPLATE_MAX_FILES) {
    throw new BoardError(
      400,
      `템플릿에는 파일을 ${TEMPLATE_MAX_FILES}개까지 넣을 수 있어요. (지금 ${paths.length}개)`,
    );
  }
  for (const path of paths) {
    try {
      assertNoPathTraversal(path);
    } catch (error: any) {
      throw new BoardError(400, error.message);
    }
    if (
      !path ||
      path.endsWith("/") ||
      path.startsWith(`${BACKUP_DIRECTORY}/`)
    ) {
      throw new BoardError(400, `템플릿에 넣을 수 없는 경로입니다: ${path}`);
    }
  }
  return paths;
}

// The author's own collections, by name, to be created empty for whoever
// applies the template. Only their permissions travel, never documents.
async function resolveCollections(
  user: User,
  value: unknown,
): Promise<BoardTemplateCollection[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BoardError(400, "컬렉션 목록이 올바르지 않습니다.");
  }
  const names = [...new Set(value as string[])];
  if (names.length === 0) return [];
  const rows = await listCollections(user, names);
  if (rows.length !== names.length) {
    throw new BoardError(400, "내 데이터베이스에 없는 컬렉션이 있어요.");
  }
  // Only the permissions travel with the template, never the author's ids.
  return rows.map(({ name, read_access, write_access }) => ({
    name,
    read_access,
    write_access,
  }));
}

function validateSlug(value: unknown): string {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    !TEMPLATE_SLUG_REGEX.test(slug) ||
    slug.length > MAX_TEMPLATE_SLUG_LENGTH
  ) {
    throw new BoardError(
      400,
      "템플릿 이름은 영문 소문자, 숫자, 하이픈(-)으로 64자까지 쓸 수 있어요.",
    );
  }
  return slug;
}

function validateChangelog(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new BoardError(400, "변경 내용이 올바르지 않습니다.");
  const changelog = value.trim();
  if (changelog.length > MAX_CHANGELOG_LENGTH) {
    throw new BoardError(
      400,
      `변경 내용은 ${MAX_CHANGELOG_LENGTH}자까지 쓸 수 있어요.`,
    );
  }
  return changelog || null;
}

// Copies every file into the version's prefix. On a failure the partial copy
// is removed and the error rethrown, so the caller's transaction can roll
// back with nothing left in the bucket.
async function copyIntoTemplate(
  templateId: string,
  version: number,
  files: TemplateSourceFile[],
): Promise<void> {
  const copied: string[] = [];
  try {
    await forEachConcurrently(files, async (file) => {
      const target = templateFileKey(templateId, version, file.path);
      await storage.copyObject(file.key, target, file.contentType);
      copied.push(target);
    });
  } catch (error) {
    await storage.deleteObjects(copied).catch(() => {});
    throw error;
  }
}

export interface PublishTemplateInput {
  title: unknown;
  body: unknown;
  slug: unknown;
  license: unknown;
  licenseAccepted: unknown;
  files: unknown;
  collections: unknown;
  // "github": versions come from a workflow; the post starts with none.
  source?: unknown;
  githubRepository?: unknown;
  githubRef?: unknown;
  githubPath?: unknown;
}

export interface GitHubSource {
  repository: string;
  ref: string;
  // The folder of the repository it publishes: '' for its root, else 'a/b'.
  // Null for a template its workflow publishes by ID.
  path: string | null;
}

// The repository, ref and folder a template's workflow publishes from.
function validateGitHubSource(
  repository: unknown,
  ref: unknown,
  folder: unknown,
): GitHubSource {
  const repo = typeof repository === "string" ? repository.trim() : "";
  if (!GITHUB_REPOSITORY_REGEX.test(repo)) {
    throw new BoardError(400, "저장소는 owner/name 꼴로 적어 주세요.");
  }
  const branch = typeof ref === "string" ? ref.trim() : "";
  const fullRef = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
  if (!GITHUB_REF_REGEX.test(fullRef)) {
    throw new BoardError(400, "브랜치 이름이 올바르지 않습니다.");
  }
  return { repository: repo, ref: fullRef, path: normalizeGitHubPath(folder) };
}

/** Another of the author's templates takes this repository, branch and folder. */
function folderTaken(error: unknown): never {
  if (
    (error as { code?: string; constraint?: string })?.code === "23505" &&
    (error as { constraint?: string }).constraint ===
      "board_templates_github_folder"
  ) {
    throw new BoardError(
      409,
      "같은 저장소·브랜치·폴더에서 버전을 받는 템플릿이 이미 있어요.",
    );
  }
  throw error;
}

function validateSource(value: unknown): TemplateSource {
  if (value === undefined || value === null || value === "site") return "site";
  if (value === "github") return "github";
  throw new BoardError(400, "버전을 올리는 곳이 올바르지 않습니다.");
}

async function assertCanPublishFromGitHub(userId: string) {
  if (!(await userHasFeature(userId, "github_deploys"))) {
    throw new BoardError(
      403,
      "GitHub Actions에서 버전을 올리려면 서포터 플랜이 필요해요.",
    );
  }
}

// Creates a template post and publishes its first version in one step.
export async function publishTemplatePost(
  user: User,
  input: PublishTemplateInput,
): Promise<{ postId: string; templateId: string }> {
  const title = validateTitle(input.title);
  const body = validatePostBody(input.body);
  const slug = validateSlug(input.slug);
  if (!isLicense(input.license)) {
    throw new BoardError(400, "라이선스를 골라 주세요.");
  }
  const license = input.license;
  if (input.licenseAccepted !== true) {
    throw new BoardError(
      400,
      `${LICENSES[license].name} 라이선스로 공개하는 데 동의해 주세요.`,
    );
  }
  const source = validateSource(input.source);
  const github =
    source === "github"
      ? validateGitHubSource(
          input.githubRepository,
          input.githubRef,
          input.githubPath,
        )
      : null;
  const selection = github ? [] : validateSelection(input.files);
  await assertCanPost(user.id);
  if (github) await assertCanPublishFromGitHub(user.id);

  const taken = await db
    .selectFrom("board_templates")
    .select("id")
    .where("user_id", "=", user.id)
    .where("slug", "=", slug)
    .executeTakeFirst();
  if (taken) {
    throw new BoardError(409, `이미 「${slug}」라는 템플릿이 있어요.`);
  }

  if (github) {
    // Its first version comes from the workflow's first run.
    return await db
      .transaction()
      .execute(async (tx) => {
        const post = await tx
          .insertInto("board_posts")
          .values({ user_id: user.id, kind: "template", title, body })
          .returning("id")
          .executeTakeFirstOrThrow();
        const template = await tx
          .insertInto("board_templates")
          .values({
            post_id: post.id,
            user_id: user.id,
            slug,
            license,
            source: "github",
            github_repository: github.repository,
            github_ref: github.ref,
            github_path: github.path,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        return { postId: post.id, templateId: template.id };
      })
      .catch(folderTaken);
  }

  const collections = await resolveCollections(user, input.collections);
  const { folder: root, files } = await collectSourceFiles(
    user.loginName,
    selection,
  );
  const size = files.reduce((sum, file) => sum + file.size, 0);

  const published = await db.transaction().execute(async (tx) => {
    const post = await tx
      .insertInto("board_posts")
      .values({ user_id: user.id, kind: "template", title, body })
      .returning("id")
      .executeTakeFirstOrThrow();
    const template = await tx
      .insertInto("board_templates")
      .values({
        post_id: post.id,
        user_id: user.id,
        slug,
        license,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const version = await tx
      .insertInto("board_template_versions")
      .values({
        template_id: template.id,
        version: 1,
        source_path: root,
        file_count: files.length,
        size_bytes: size,
        data_collections: JSON.stringify(collections),
        site_code: hasSiteCode(files.map((file) => file.path)),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("board_template_files")
      .values(
        files.map((file) => ({
          version_id: version.id,
          path: file.path,
          size_bytes: file.size,
          content_type: file.contentType,
        })),
      )
      .execute();
    await tx
      .updateTable("board_templates")
      .set({ latest_version_id: version.id })
      .where("id", "=", template.id)
      .execute();
    await copyIntoTemplate(template.id, 1, files);
    await recordVersionEtags(tx, template.id, 1, version.id);
    // Durable work is visible only after this version commits.
    await enqueueTemplatePreview(tx, version.id);
    return { postId: post.id, templateId: template.id, versionId: version.id };
  });
  await recordVersionTables(published.versionId);
  return { postId: published.postId, templateId: published.templateId };
}

async function findLiveTemplate(templateId: string) {
  const template = await db
    .selectFrom("board_templates as t")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .leftJoin("board_template_versions as v", "v.id", "t.latest_version_id")
    .select([
      "t.id",
      "t.user_id",
      "t.post_id",
      "t.source",
      "v.version",
      "v.source_path",
    ])
    .where("t.id", "=", templateId)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!template) throw new BoardError(404, "템플릿을 찾을 수 없습니다.");
  return template;
}

export async function publishTemplateVersion(
  user: User,
  templateId: string,
  input: {
    files: unknown;
    changelog: unknown;
    collections: unknown;
  },
): Promise<number> {
  const template = await findLiveTemplate(templateId);
  if (template.user_id !== user.id) {
    throw new BoardError(403, "내 템플릿만 새 버전을 올릴 수 있어요.");
  }
  if (template.source === "github") {
    throw new BoardError(
      400,
      "이 템플릿은 GitHub Actions에서 새 버전을 올려요. 버전 올리는 곳을 내 사이트로 바꾸면 여기서 올릴 수 있어요.",
    );
  }
  const selection = validateSelection(input.files);
  const changelog = validateChangelog(input.changelog);
  const collections = await resolveCollections(user, input.collections);
  const { folder: root, files } = await collectSourceFiles(
    user.loginName,
    selection,
  );
  const size = files.reduce((sum, file) => sum + file.size, 0);

  const published = await db.transaction().execute(async (tx) => {
    // Serialises two publishes of the same template.
    await tx
      .selectFrom("board_templates")
      .select("id")
      .where("id", "=", templateId)
      .forUpdate()
      .execute();
    const latest = await tx
      .selectFrom("board_template_versions")
      .select(sql<number>`coalesce(max(version), 0)`.as("version"))
      .where("template_id", "=", templateId)
      .executeTakeFirstOrThrow();
    const versionNumber = Number(latest.version) + 1;
    const version = await tx
      .insertInto("board_template_versions")
      .values({
        template_id: templateId,
        version: versionNumber,
        source_path: root,
        file_count: files.length,
        size_bytes: size,
        data_collections: JSON.stringify(collections),
        changelog,
        site_code: hasSiteCode(files.map((file) => file.path)),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("board_template_files")
      .values(
        files.map((file) => ({
          version_id: version.id,
          path: file.path,
          size_bytes: file.size,
          content_type: file.contentType,
        })),
      )
      .execute();
    await tx
      .updateTable("board_templates")
      .set({ latest_version_id: version.id })
      .where("id", "=", templateId)
      .execute();
    await tx
      .updateTable("board_posts")
      .set({ activity_at: sql`now()` })
      .where("id", "=", template.post_id)
      .execute();
    await copyIntoTemplate(templateId, versionNumber, files);
    await recordVersionEtags(tx, templateId, versionNumber, version.id);
    await enqueueTemplatePreview(tx, version.id);
    await notifyTemplateVersion(tx, templateId, version.id);
    return { versionNumber, versionId: version.id };
  });
  await recordVersionTables(published.versionId);
  return published.versionNumber;
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

async function ownLiveTemplate(user: User, templateId: string) {
  const template = await findLiveTemplate(templateId);
  if (template.user_id !== user.id) {
    throw new BoardError(403, "내 템플릿의 미리보기만 바꿀 수 있어요.");
  }
  return template;
}

/**
 * Sets the template's own preview image, shown in place of its versions'
 * screenshots: for templates that show nothing without their site's data.
 */
export async function setTemplatePreview(
  user: User,
  templateId: string,
  bytes: Uint8Array,
): Promise<void> {
  await ownLiveTemplate(user, templateId);
  await storeTemplatePreview(templateId, bytes);
}

/** Back to the screenshots of the template's versions. */
export async function removeTemplatePreview(
  user: User,
  templateId: string,
): Promise<void> {
  await ownLiveTemplate(user, templateId);
  await clearTemplatePreview(templateId);
}

/**
 * Where a template's new versions come from: its author's site (each "새 버전
 * 올리기"), or a GitHub Actions workflow on `repository` and `ref`.
 */
export async function setTemplateSource(
  user: User,
  templateId: string,
  input: {
    source: unknown;
    githubRepository?: unknown;
    githubRef?: unknown;
    githubPath?: unknown;
  },
): Promise<void> {
  const template = await findLiveTemplate(templateId);
  if (template.user_id !== user.id) {
    throw new BoardError(403, "내 템플릿만 고칠 수 있어요.");
  }
  const source = validateSource(input.source);
  if (source === "site") {
    await db
      .updateTable("board_templates")
      .set({ source: "site" })
      .where("id", "=", templateId)
      .execute();
    return;
  }
  const github = validateGitHubSource(
    input.githubRepository,
    input.githubRef,
    input.githubPath,
  );
  await assertCanPublishFromGitHub(user.id);
  await db
    .updateTable("board_templates")
    .set((eb) => ({
      source: "github",
      github_repository: github.repository,
      github_ref: github.ref,
      github_path: github.path,
      // A different repository is a different identity to bind.
      github_repository_id: eb
        .case()
        .when("github_repository", "=", github.repository)
        .then(eb.ref("github_repository_id"))
        .else(null)
        .end(),
    }))
    .where("id", "=", templateId)
    .execute()
    .catch(folderTaken);
}

export interface TemplateDetail {
  id: string;
  slug: string;
  license: License;
  applyCount: number;
  source: TemplateSource;
  github: GitHubSource | null;
  // The author's own preview image, else the latest version's screenshot.
  previewUrl: string | null;
  customPreview: boolean;
  versions: {
    id: string;
    version: number;
    sourcePath: string;
    fileCount: number;
    sizeBytes: number;
    collections: BoardTemplateCollection[];
    changelog: string | null;
    previewUrl: string | null;
    createdAt: Date;
    siteCode: boolean;
    githubSha: string | null;
    // Site code migrations this version adds to the one before it.
    newMigrations: string[];
    // The tables its migrations make in an empty site database, or null
    // when not known (no site code, or not tried yet).
    tables: string[] | null;
  }[];
  files: { path: string; sizeBytes: number }[];
}

export async function getTemplateForPost(
  postId: string,
): Promise<TemplateDetail | null> {
  const template = await db
    .selectFrom("board_templates as t")
    .select([
      "t.id",
      "t.slug",
      "t.license",
      "t.apply_count",
      "t.latest_version_id",
      "t.source",
      "t.github_repository",
      "t.github_ref",
      "t.github_path",
      "t.preview_updated_at",
    ])
    .where("t.post_id", "=", postId)
    .executeTakeFirst();
  if (!template) return null;

  const versions = await db
    .selectFrom("board_template_versions")
    .selectAll()
    .where("template_id", "=", template.id)
    .orderBy("version", "desc")
    .execute();
  // Versions from before tables were recorded are tried as they are shown.
  const latestTables =
    versions[0]?.site_code && versions[0].site_tables === null
      ? await recordVersionTables(versions[0].id)
      : (versions[0]?.site_tables ?? null);
  const migrations = await db
    .selectFrom("board_template_files as f")
    .innerJoin("board_template_versions as v", "v.id", "f.version_id")
    .select(["v.version", "f.path"])
    .where("v.template_id", "=", template.id)
    .where("f.path", "like", "\\_naru/migrations/%")
    .execute();
  const migrationsOf = (version: number) =>
    new Set(
      migrations.filter((row) => row.version === version).map((r) => r.path),
    );
  const files = template.latest_version_id
    ? await db
        .selectFrom("board_template_files")
        .select(["path", "size_bytes"])
        .where("version_id", "=", template.latest_version_id)
        .orderBy("path")
        .execute()
    : [];

  return {
    id: template.id,
    slug: template.slug,
    license: template.license,
    applyCount: template.apply_count,
    source: template.source,
    github:
      template.github_repository && template.github_ref
        ? {
            repository: template.github_repository,
            ref: template.github_ref,
            path: template.github_path,
          }
        : null,
    previewUrl: templatePreviewUrl({
      id: template.id,
      customPreviewAt: template.preview_updated_at,
      version: versions[0]?.version ?? null,
      renderedAt: versions[0]?.preview_rendered_at ?? null,
    }),
    customPreview: template.preview_updated_at !== null,
    versions: versions.map((version, index) => ({
      id: version.id,
      version: version.version,
      sourcePath: version.source_path,
      fileCount: version.file_count,
      sizeBytes: Number(version.size_bytes),
      collections: version.data_collections,
      changelog: version.changelog,
      previewUrl: getTemplatePreviewUrl(
        template.id,
        version.version,
        version.preview_rendered_at,
      ),
      createdAt: version.created_at,
      siteCode: version.site_code,
      githubSha: version.github_sha,
      tables: index === 0 ? latestTables : version.site_tables,
      newMigrations: (() => {
        const before = versions[index + 1]
          ? migrationsOf(versions[index + 1].version)
          : new Set<string>();
        return [...migrationsOf(version.version)]
          .filter((path) => !before.has(path))
          .sort();
      })(),
    })),
    files: files.map((file) => ({
      path: file.path,
      sizeBytes: Number(file.size_bytes),
    })),
  };
}

// The users who applied a template, for the "적용함" badge on their replies.
export async function listTemplateAppliers(
  templateId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom("board_template_applications as a")
    .innerJoin("board_template_versions as v", "v.id", "a.version_id")
    .select(["a.user_id", sql<number>`max(v.version)`.as("version")])
    .where("v.template_id", "=", templateId)
    .groupBy("a.user_id")
    .execute();
  return new Map(rows.map((row) => [row.user_id, Number(row.version)]));
}

async function findApplicableVersion(versionId: string) {
  const version = await db
    .selectFrom("board_template_versions as v")
    .innerJoin("board_templates as t", "t.id", "v.template_id")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .select([
      "v.id",
      "v.version",
      "v.template_id",
      "v.data_collections",
      "v.site_code",
      "t.slug",
    ])
    .where("v.id", "=", versionId)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!version) throw new BoardError(404, "템플릿을 찾을 수 없습니다.");
  return version;
}

export interface ApplicationPlan {
  targetPath: string;
  // The template has site code (_naru/): it installs at the site's root.
  siteCode: boolean;
  // Why it cannot be applied now; empty when it can.
  blockers: string[];
  files: {
    path: string;
    sizeBytes: number;
    action: "create" | "overwrite";
  }[];
  collections: {
    name: string;
    action: "create" | "exists" | "unavailable";
  }[];
  totalBytes: number;
  // Another template's site code is installed (a site has one): applying
  // this one with `replace` removes that template's files still as it wrote
  // them, keeps those the owner changed, and forgets its install. Its
  // `migrations` have run, so they stay, unless the database is reset.
  replaces: {
    installId: string;
    slug: string;
    remove: string[];
    keep: string[];
    migrations: string[];
  } | null;
  // Why this version's migrations cannot run on the site's database as it
  // is (site-code.ts). Applying with `resetDatabase` empties it first.
  migrationConflicts: string[];
  // Whether the site's database may be reset for this: site code, and the
  // database feature.
  canResetDatabase: boolean;
}

function normalizeTarget(value: unknown): string {
  const target = normalizeFolder(value);
  if (
    target === `${BACKUP_DIRECTORY}/` ||
    target.startsWith(`${BACKUP_DIRECTORY}/`)
  ) {
    throw new BoardError(400, "백업 폴더에는 적용할 수 없어요.");
  }
  return target;
}

/**
 * Another template whose site code is installed on this site: a site has
 * one _naru/, so it must be disconnected before another is installed.
 */
async function otherSiteCodeInstall(userId: string, templateId: string) {
  return await db
    .selectFrom("board_template_installs as i")
    .innerJoin("board_template_versions as v", "v.id", "i.version_id")
    .innerJoin("board_templates as t", "t.id", "i.template_id")
    .select(["i.id", "i.target_path", "i.files", "t.slug"])
    .where("i.user_id", "=", userId)
    .where("i.template_id", "<>", templateId)
    .where("v.site_code", "=", true)
    .executeTakeFirst();
}

// What applying would do, without writing anything. Apply recomputes it
// rather than trusting the plan the page was shown.
export async function planApplication(
  user: User,
  versionId: string,
  targetInput: unknown,
): Promise<ApplicationPlan> {
  const version = await findApplicableVersion(versionId);
  const targetPath = normalizeTarget(targetInput);
  if (version.site_code && targetPath !== "") {
    throw new BoardError(
      400,
      "사이트 코드가 있는 템플릿은 사이트 전체(/)에만 설치할 수 있어요.",
    );
  }
  const files = await db
    .selectFrom("board_template_files")
    .select(["path", "size_bytes"])
    .where("version_id", "=", version.id)
    .orderBy("path")
    .execute();

  const home = `${getUserHomeDirectory(user.loginName)}/`;
  const existing = new Set(
    (await storage.listObjects(`${home}${targetPath}`)).map((object) =>
      object.key.slice(home.length),
    ),
  );

  const hasDatabase = (await getUserFeatures(user.id)).has("database");
  const collectionNames = version.data_collections.map((c) => c.name);
  const existingCollections = new Set(
    (await listCollections(user, collectionNames)).map((row) => row.name),
  );

  const blockers: string[] = [];
  let replaces: ApplicationPlan["replaces"] = null;
  if (version.site_code) {
    if (!hasDatabase) {
      blockers.push(
        "사이트 코드가 있는 템플릿은 데이터베이스가 필요해요. 서포터 플랜에서 쓸 수 있어요.",
      );
    }
    const other = await otherSiteCodeInstall(user.id, version.template_id);
    if (other) {
      // What this template writes is overwritten (and backed up) anyway.
      const writes = new Set(files.map((file) => `${targetPath}${file.path}`));
      const states = await installFileStates(user.loginName, other);
      const untouched = states.untouched.filter((path) => !writes.has(path));
      replaces = {
        installId: other.id,
        slug: other.slug,
        remove: untouched.filter((path) => !isMigration(path)),
        keep: states.changed.filter((path) => !writes.has(path)),
        migrations: untouched.filter(isMigration),
      };
    }
  }
  let conflicts: string[] = [];
  if (version.site_code && hasDatabase) {
    const migrations = files.filter((file) => isMigration(file.path));
    const [applied, tables, sources] = await Promise.all([
      appliedMigrations(user.loginName),
      siteTableNames(user.loginName),
      Promise.all(
        migrations.map(async (file) => ({
          name: file.path.slice(MIGRATIONS_PREFIX.length),
          sql:
            (await storage.getText(
              templateFileKey(version.template_id, version.version, file.path),
            )) ?? "",
        })),
      ),
    ]);
    conflicts = migrationConflicts(applied, tables, sources);
  }

  const planned = files.map((file) => {
    const path = `${targetPath}${file.path}`;
    return {
      path,
      sizeBytes: Number(file.size_bytes),
      action: existing.has(path) ? ("overwrite" as const) : ("create" as const),
    };
  });
  return {
    targetPath,
    siteCode: version.site_code,
    blockers,
    files: planned,
    collections: collectionNames.map((name) => ({
      name,
      action: existingCollections.has(name)
        ? "exists"
        : hasDatabase
          ? "create"
          : "unavailable",
    })),
    totalBytes: planned.reduce((sum, file) => sum + file.sizeBytes, 0),
    replaces,
    migrationConflicts: conflicts,
    canResetDatabase: version.site_code && hasDatabase,
  };
}

export interface ApplicationResult {
  applicationId: string;
  installId: string;
  targetPath: string;
  backupPath: string | null;
  written: number;
  overwritten: number;
  createdCollections: string[];
  skippedCollections: string[];
  // Not created because the site has no database feature.
  unavailableCollections: string[];
  // The template whose site code this one replaced, and what of its files.
  replaced: { slug: string; removed: number; kept: number } | null;
  // The restore point kept before the site's database was reset, if it was.
  restorePoint: string | null;
}

/** Why the site's code was refused, for a person to read. */
function refusalMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * How far an application has got, for the page to show: keeping the site's
 * database before resetting it, backing up the files it overwrites, copying the template's files in, publishing the site's code,
 * and creating collections.
 */
export type ApplyProgress = {
  phase: "database" | "backup" | "copy" | "code" | "collections";
  done: number;
  total: number;
};

/**
 * Applies a version to the person's site, all or nothing: if a file cannot be
 * copied, or Naru refuses the site's code, every file goes back as it was and
 * nothing is recorded. One application or update runs at a time per site.
 */
export async function applyTemplate(
  user: User,
  versionId: string,
  input: {
    targetPath: unknown;
    backup: unknown;
    createCollections: unknown;
    // Told of new versions; true unless false.
    notify?: unknown;
    // Replaces another template's installed site code (the plan's
    // `replaces`); without it, that is refused.
    replace?: unknown;
    // The site's name, to empty its database first (a restore point is kept
    // before): for migrations that cannot run on it as it is.
    resetDatabase?: unknown;
    onProgress?: (progress: ApplyProgress) => void;
  },
): Promise<ApplicationResult> {
  if (await siteSuspended(user.id))
    throw new BoardError(403, SUSPENDED_MESSAGE);
  return await withSiteLock(user.id, () => applyLocked(user, versionId, input));
}

async function applyLocked(
  user: User,
  versionId: string,
  input: Parameters<typeof applyTemplate>[2],
): Promise<ApplicationResult> {
  const report = input.onProgress ?? (() => {});
  await assertUnderHourlyLimit(
    "board_template_applications",
    user.id,
    APPLICATIONS_PER_HOUR,
  );
  if (
    input.notify !== undefined &&
    input.notify !== null &&
    typeof input.notify !== "boolean"
  )
    throw new BoardError(400, "새 버전 알림 설정이 올바르지 않습니다.");
  const notify = input.notify !== false;
  const version = await findApplicableVersion(versionId);
  const plan = await planApplication(user, versionId, input.targetPath);
  if (plan.blockers.length > 0) throw new BoardError(409, plan.blockers[0]);
  const replaces = plan.replaces;
  if (replaces && input.replace !== true)
    throw new BoardError(
      409,
      `다른 템플릿(${replaces.slug})의 사이트 코드가 설치되어 있어요. 이 템플릿으로 바꾸려면 바꾸기를 골라 주세요.`,
    );
  const reset =
    input.resetDatabase !== undefined &&
    input.resetDatabase !== null &&
    input.resetDatabase !== false;
  if (
    reset &&
    (!plan.canResetDatabase || input.resetDatabase !== user.loginName)
  )
    throw new BoardError(
      400,
      "데이터베이스를 초기화하려면 사이트 이름을 정확히 입력해 주세요.",
    );
  if (plan.migrationConflicts.length > 0 && !reset)
    throw new BoardError(409, plan.migrationConflicts[0]);
  // With the database reset, the replaced template's migrations are history
  // no more, and go with its other files.
  const removed = replaces
    ? [...replaces.remove, ...(reset ? replaces.migrations : [])]
    : [];
  // Site code is put back on failure, so its backups are always kept.
  const keepBackup = plan.siteCode || input.backup !== false;
  const overwritten = plan.files
    .filter((file) => file.action === "overwrite")
    .map((file) => file.path);
  const created = plan.files
    .filter((file) => file.action === "create")
    .map((file) => file.path);
  // Overwritten files are backed up even when the person asked for no
  // backup, so a failure can put them back; that backup has a folder of its
  // own and goes once the template is in.
  const backedUp = [...overwritten, ...removed];
  const backupPath =
    backedUp.length === 0
      ? null
      : keepBackup
        ? `${BACKUP_DIRECTORY}/${backupStamp(new Date())}/`
        : `${BACKUP_DIRECTORY}/.applying-${uuidv7()}/`;

  // The database is kept before anything changes, to come back to.
  let restorePoint: string | null = null;
  if (reset) {
    report({ phase: "database", done: 0, total: 1 });
    restorePoint = await saveDatabase(user.id);
  }

  // Backups first: if anything after this fails, the originals are safe.
  if (backupPath) {
    let done = 0;
    report({ phase: "backup", done, total: backedUp.length });
    await backUp(user.loginName, backupPath, backedUp, () =>
      report({ phase: "backup", done: ++done, total: backedUp.length }),
    );
  }

  const written: string[] = [];
  const sources = await db
    .selectFrom("board_template_files")
    .select(["path", "content_type"])
    .where("version_id", "=", version.id)
    .execute();
  try {
    if (reset) await eraseDatabase(user.loginName, user.id);
    // The replaced template's files go first; they come back on a failure.
    if (removed.length > 0)
      await storage.deleteObjects(
        removed.map((path) => getUserObjectKey(user.loginName, path)),
      );
    report({ phase: "copy", done: 0, total: sources.length });
    await forEachConcurrently(sources, async (file) => {
      const path = `${plan.targetPath}${file.path}`;
      await storage.copyObject(
        templateFileKey(version.template_id, version.version, file.path),
        getUserObjectKey(user.loginName, path),
        file.content_type,
      );
      written.push(path);
      report({ phase: "copy", done: written.length, total: sources.length });
    });
    if (plan.siteCode) report({ phase: "code", done: 0, total: 1 });
    // Purging publishes the site's code when the files hold some, and Naru
    // may refuse it (a migration that fails). For files alone it only
    // refreshes caches, which expire anyway.
    await storage
      .purgeSiteFiles(user.loginName, [...written, ...removed])
      .catch((error) => {
        if (plan.siteCode) throw error;
        console.error("Purge after applying a template", error);
      });
  } catch (error) {
    // The database first, so the old code, published again below, finds
    // its tables and migrations.
    let databaseBack = true;
    if (restorePoint)
      await restoreDatabase(user.id, restorePoint).catch((cause) => {
        databaseBack = false;
        console.error("Restoring the database after a template", cause);
      });
    await putBack(user.loginName, {
      backupPath,
      backedUp: backupPath ? backedUp : [],
      created,
    });
    await storage
      .purgeSiteFiles(user.loginName, [...written, ...removed])
      .catch((cause) => console.error("Purge after putting back", cause));
    if (backupPath && !keepBackup) await removeBackup(user, backupPath);
    const database = !restorePoint
      ? ""
      : databaseBack
        ? " 데이터베이스도 되돌렸어요."
        : ` 데이터베이스는 되돌리지 못했어요. 데이터베이스 관리에서 복원 지점 ${restorePoint}로 되돌려 주세요.`;
    throw new BoardError(
      422,
      plan.siteCode
        ? `사이트 코드를 적용하지 못해서 설치를 되돌렸어요: ${refusalMessage(error)}${database}`
        : "템플릿 파일을 복사하지 못해서 적용을 되돌렸어요. 잠시 뒤에 다시 해 주세요.",
    );
  }
  if (backupPath && !keepBackup) await removeBackup(user, backupPath);

  const createdCollections: string[] = [];
  const skippedCollections: string[] = [];
  const unavailableCollections: string[] = [];
  const wanted = input.createCollections !== false;
  const toCreate = version.data_collections.filter((collection) => {
    const planned = plan.collections.find((c) => c.name === collection.name);
    if (wanted && planned?.action === "create") return true;
    if (planned?.action === "unavailable") {
      unavailableCollections.push(collection.name);
    } else if (planned?.action !== "exists") {
      skippedCollections.push(collection.name);
    }
    return false;
  });

  const files = await installedFiles(user.loginName, plan.targetPath, written);
  const { application, installId } = await db
    .transaction()
    .execute(async (tx) => {
      const firstTime = !(await tx
        .selectFrom("board_template_applications as a")
        .innerJoin("board_template_versions as v", "v.id", "a.version_id")
        .select("a.id")
        .where("a.user_id", "=", user.id)
        .where("v.template_id", "=", version.template_id)
        .executeTakeFirst());

      const row = await tx
        .insertInto("board_template_applications")
        .values({
          version_id: version.id,
          user_id: user.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      if (firstTime) {
        await tx
          .updateTable("board_templates")
          .set({ apply_count: sql`apply_count + 1` })
          .where("id", "=", version.template_id)
          .execute();
      }
      // The replaced template's install goes with its files.
      if (replaces)
        await tx
          .deleteFrom("board_template_installs")
          .where("id", "=", replaces.installId)
          .where("user_id", "=", user.id)
          .execute();
      const installId = await recordInstall(tx, {
        userId: user.id,
        templateId: version.template_id,
        versionId: version.id,
        targetPath: plan.targetPath,
        notify,
        files,
      });
      return { application: row, installId };
    });

  // After the application is recorded: the collections are in the site's
  // Durable Object, outside this transaction. They are empty, so one that
  // fails is only reported as skipped; the files are in place either way.
  if (toCreate.length > 0) {
    report({ phase: "collections", done: 0, total: toCreate.length });
    let createdNames: string[] | null = null;
    try {
      createdNames = await createCollections(user, toCreate);
    } catch (error) {
      console.error("Template collections were not created", error);
    }
    if (createdNames === null) {
      skippedCollections.push(...toCreate.map((c) => c.name));
    } else {
      createdCollections.push(...createdNames);
    }
  }

  await recordSiteEdit(user.id);

  return {
    applicationId: application.id,
    installId,
    targetPath: plan.targetPath,
    backupPath: keepBackup ? backupPath : null,
    written: written.length,
    overwritten: overwritten.length,
    createdCollections,
    skippedCollections,
    unavailableCollections,
    replaced: replaces
      ? {
          slug: replaces.slug,
          removed: removed.length,
          kept: replaces.keep.length,
        }
      : null,
    restorePoint,
  };
}

/** A backup the person did not ask for, kept only while applying. */
async function removeBackup(user: User, backupPath: string) {
  await storage
    .deletePrefix(getUserObjectKey(user.loginName, backupPath))
    .catch((error) => console.error("Could not remove a backup", error));
}

// Removes a template's files and previews from R2. The rows stay (the post is
// soft-deleted), so the record of who applied it is kept.
export async function deleteTemplateObjects(templateId: string): Promise<void> {
  await storage.deletePrefix(templatePrefix(templateId));
}

// Account deletion: the rows cascade with the user, but R2 does not.
export async function deleteUserTemplateObjects(userId: string): Promise<void> {
  const templates = await db
    .selectFrom("board_templates")
    .select("id")
    .where("user_id", "=", userId)
    .execute();
  for (const template of templates) {
    await deleteTemplateObjects(template.id);
  }
}
