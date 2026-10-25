// Template versions a GitHub Actions workflow publishes, through the same
// three calls as a site deploy (/api/deploy/github/plan, finalize, status)
// with `template` in place of `site`:
//
// 1. plan: the run's OIDC token must name the template's repository and
//    ref. Files the previous version had with the same sha256 are reused;
//    the rest get signed upload URLs to a staging prefix.
// 2. finalize: the staged files are checked against the manifest, the site
//    code in them must parse, and the version is published: copied under
//    _templates/<id>/v<n>/, with each file's sha256 and ETag, a preview
//    queued, and its installs told.
//
// A workflow may name a preview image beside the files: staged the same way
// (unless it is the one the template already shows), and set as the
// template's own preview on finalize.
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { enqueueTemplatePreview } from "@/lib/maintenance/jobs";
import { s3Client } from "@/lib/s3";
import { moduleImports } from "@/lib/site-functions/modules";
import {
  assertGitHubClaimsAllowed,
  contentTypeFor,
  DEPLOYMENT_TTL_MS,
  deleteObjects,
  deploymentId,
  eachLimit,
  PUBLISH_CONCURRENCY,
  readObjectText,
  sha256Object,
  UPLOAD_URL_TTL_SECONDS,
  validateManifest,
  type DeployManifest,
} from "@/lib/deploy/siteDeploy";
import type { GitHubActionsClaims } from "@/lib/deploy/githubOidc";
import {
  hasSiteCode,
  MAX_CHANGELOG_LENGTH,
  SITE_CODE_PREFIX,
  TEMPLATE_GITHUB_MAX_BYTES,
  TEMPLATE_GITHUB_MAX_FILES,
  TEMPLATE_PREVIEW_TYPES,
  formatBytes,
} from "./constants";
import { normalizeGitHubPath } from "./github-source";
import { notifyTemplateVersion, recordVersionEtags } from "./installs";
import { templateFileKey } from "./preview";
import {
  assertPreviewSize,
  sniffPreviewType,
  storeTemplatePreview,
} from "./template-preview";
import * as storage from "./storage";

function bucket() {
  return process.env.S3_BUCKET_NAME!;
}

async function findGitHubTemplate(templateId: string) {
  const template = await db
    .selectFrom("board_templates as t")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .select([
      "t.id",
      "t.user_id",
      "t.post_id",
      "t.source",
      "t.github_repository",
      "t.github_ref",
      "t.github_repository_id",
      "t.latest_version_id",
      "t.preview_sha256",
    ])
    .where("t.id", "=", templateId)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!template) throw new Error("Template was not found");
  if (
    template.source !== "github" ||
    !template.github_repository ||
    !template.github_ref
  ) {
    throw new Error("This template does not publish from GitHub Actions");
  }
  return {
    ...template,
    github_repository: template.github_repository,
    github_ref: template.github_ref,
  };
}

/**
 * The template `owner` publishes from the run's repository and branch and
 * this folder of it, or null when they have none (yet).
 */
async function templateForFolder(
  claims: GitHubActionsClaims,
  owner: string,
  folder: unknown,
): Promise<string | null> {
  const template = await db
    .selectFrom("board_templates as t")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .innerJoin("users as u", "u.id", "t.user_id")
    .select("t.id")
    .where("u.login_name", "=", owner)
    .where("t.source", "=", "github")
    .where("t.github_repository", "=", claims.repository)
    .where("t.github_ref", "=", claims.ref)
    .where("t.github_path", "=", normalizeGitHubPath(folder))
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  return template?.id ?? null;
}

/** A template's manifest: deploy paths, within the template limits. */
function validateTemplateManifest(input: unknown): DeployManifest {
  const manifest = validateManifest(input, { requireIndex: false });
  if (manifest.files.length === 0) {
    throw new Error("Template manifest has no files");
  }
  if (manifest.files.length > TEMPLATE_GITHUB_MAX_FILES) {
    throw new Error(
      `A template holds at most ${TEMPLATE_GITHUB_MAX_FILES} files (this one ${manifest.files.length})`,
    );
  }
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  if (total > TEMPLATE_GITHUB_MAX_BYTES) {
    throw new Error(
      `A template holds at most ${formatBytes(TEMPLATE_GITHUB_MAX_BYTES)} (this one ${formatBytes(total)})`,
    );
  }
  for (const file of manifest.files) {
    if (file.path.startsWith(".backup/")) {
      throw new Error(`A template cannot hold ${file.path}`);
    }
  }
  return manifest;
}

interface PreviewManifest {
  size: number;
  sha256: string;
  contentType: string;
}

/** The preview image a workflow names: its size, SHA-256 and type. */
function validatePreview(input: unknown): PreviewManifest | null {
  if (input === undefined || input === null) return null;
  const preview = input as Record<string, unknown>;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid preview");
  }
  const size = Number(preview.size);
  assertPreviewSize(size);
  if (
    typeof preview.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(preview.sha256)
  ) {
    throw new Error("Invalid preview sha256");
  }
  if (
    !(TEMPLATE_PREVIEW_TYPES as readonly unknown[]).includes(
      preview.contentType,
    )
  ) {
    throw new Error("A preview is a PNG, JPEG or WebP image");
  }
  return {
    size,
    sha256: preview.sha256,
    contentType: preview.contentType as string,
  };
}

const PREVIEW_STAGING_NAME = ".naru-preview";

function validateChangelog(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const changelog = value.trim();
  return changelog ? changelog.slice(0, MAX_CHANGELOG_LENGTH) : null;
}

/** The previous version's files, by path, that a new one can reuse. */
async function reusableFiles(versionId: string | null) {
  if (!versionId) return new Map<string, string>();
  const rows = await db
    .selectFrom("board_template_files as f")
    .innerJoin("board_template_versions as v", "v.id", "f.version_id")
    .select(["f.path", "f.sha256", "v.version", "v.template_id"])
    .where("f.version_id", "=", versionId)
    .where("f.sha256", "is not", null)
    .execute();
  return new Map(
    rows.map((row) => [
      `${row.path}\0${row.sha256}`,
      templateFileKey(row.template_id, row.version, row.path),
    ]),
  );
}

export async function planTemplateUpload(params: {
  claims: GitHubActionsClaims;
  // The template by ID, or by its owner's login and the repository's folder.
  templateId?: string;
  owner?: string;
  folder?: unknown;
  manifest: unknown;
  changelog?: unknown;
  // An image to show for the template instead of its screenshots.
  preview?: unknown;
}) {
  const templateId =
    params.templateId ??
    (await templateForFolder(params.claims, params.owner ?? "", params.folder));
  if (!templateId) {
    // Not an error: the workflow may run before its template's post exists,
    // and publishes into it from the first run after.
    return {
      skipped: true as const,
      message: `${params.owner} has no template publishing ${params.claims.repository} ${params.claims.ref.replace(/^refs\/heads\//, "")} /${normalizeGitHubPath(params.folder)} yet`,
      uploads: [],
    };
  }
  const template = await findGitHubTemplate(templateId);
  if (!(await userHasFeature(template.user_id, "github_deploys"))) {
    throw new Error("GitHub deploys are available to supporters only");
  }
  assertGitHubClaimsAllowed(params.claims, {
    github_repository: template.github_repository,
    github_repository_id: template.github_repository_id,
    github_ref: template.github_ref,
  });
  const manifest = validateTemplateManifest(params.manifest);
  const requestedPreview = validatePreview(params.preview);
  // The one the template shows already needs no upload.
  const preview =
    requestedPreview && requestedPreview.sha256 !== template.preview_sha256
      ? requestedPreview
      : null;
  // The repository's identity is bound on first use, as a deploy target's is.
  const bound = await db
    .updateTable("board_templates")
    .set({ github_repository_id: params.claims.repository_id })
    .where("id", "=", template.id)
    .where((eb) =>
      eb.or([
        eb("github_repository_id", "is", null),
        eb("github_repository_id", "=", params.claims.repository_id),
      ]),
    )
    .executeTakeFirst();
  if (!bound.numUpdatedRows) {
    throw new Error("Template is bound to a different GitHub repository");
  }

  const reusable = await reusableFiles(template.latest_version_id);
  const uploadedPaths = manifest.files
    .filter((file) => !reusable.has(`${file.path}\0${file.sha256}`))
    .map((file) => file.path);
  const id = deploymentId();
  const uploadPrefix = `__deploy_uploads/${template.user_id}/${id}`;
  const expiresAt = new Date(Date.now() + DEPLOYMENT_TTL_MS);
  await db
    .insertInto("board_template_uploads")
    .values({
      id,
      template_id: template.id,
      user_id: template.user_id,
      github_repository_id: params.claims.repository_id,
      github_ref: params.claims.ref,
      github_sha: params.claims.sha,
      upload_prefix: uploadPrefix,
      manifest: JSON.stringify(manifest),
      uploaded_paths: JSON.stringify(uploadedPaths),
      changelog: validateChangelog(params.changelog),
      preview_size: preview?.size ?? null,
      preview_sha256: preview?.sha256 ?? null,
      preview_content_type: preview?.contentType ?? null,
      expires_at: expiresAt,
    })
    .execute();

  const uploads = await Promise.all(
    uploadedPaths.map(async (path) => ({
      path,
      method: "PUT",
      url: await getSignedUrl(
        s3Client as any,
        new PutObjectCommand({
          Bucket: bucket(),
          Key: `${uploadPrefix}/${path}`,
        }) as any,
        { expiresIn: UPLOAD_URL_TTL_SECONDS },
      ),
      headers: {},
    })),
  );
  const previewUpload = preview
    ? {
        method: "PUT",
        url: await getSignedUrl(
          s3Client as any,
          new PutObjectCommand({
            Bucket: bucket(),
            Key: `${uploadPrefix}/${PREVIEW_STAGING_NAME}`,
          }) as any,
          { expiresIn: UPLOAD_URL_TTL_SECONDS },
        ),
        headers: {},
      }
    : null;
  return {
    deploymentId: id,
    expiresAt: expiresAt.toISOString(),
    uploads,
    previewUpload,
    deletedPaths: [] as string[],
  };
}

/** Whether `id` names a template upload rather than a site deployment. */
export async function isTemplateUpload(id: string): Promise<boolean> {
  return !!(await db
    .selectFrom("board_template_uploads")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst());
}

async function loadUpload(claims: GitHubActionsClaims, id: string) {
  const upload = await db
    .selectFrom("board_template_uploads")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!upload || upload.github_repository_id !== claims.repository_id) {
    throw new Error("Deployment was not found");
  }
  const template = await findGitHubTemplate(upload.template_id);
  assertGitHubClaimsAllowed(claims, {
    github_repository: template.github_repository,
    github_repository_id: template.github_repository_id,
    github_ref: template.github_ref,
  });
  return { upload, template };
}

/** Site code a version carries must at least parse, as a release's would. */
async function assertSiteCodeParses(
  manifest: DeployManifest,
  keyOf: (path: string) => string,
) {
  for (const file of manifest.files) {
    if (!file.path.startsWith(SITE_CODE_PREFIX)) continue;
    const name = file.path.slice(SITE_CODE_PREFIX.length);
    if (/\.m?js$/.test(name)) {
      moduleImports(await readObjectText(keyOf(file.path)), name);
    } else if (name === "routes.json" || name === "collections.json") {
      try {
        JSON.parse(await readObjectText(keyOf(file.path)));
      } catch {
        throw new Error(`${file.path} is not valid JSON`);
      }
    }
  }
}

/**
 * The preview image a workflow staged, checked against what its plan said;
 * null when it named none, or the one the template shows already.
 */
async function stagedPreview(upload: {
  upload_prefix: string;
  preview_size: number | null;
  preview_sha256: string | null;
}): Promise<Uint8Array | null> {
  if (upload.preview_sha256 === null) return null;
  const key = `${upload.upload_prefix}/${PREVIEW_STAGING_NAME}`;
  let bytes: Uint8Array;
  try {
    const object = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
    );
    bytes = await object.Body!.transformToByteArray();
  } catch {
    throw new Error("The preview image was not uploaded");
  }
  if (
    bytes.byteLength !== upload.preview_size ||
    createHash("sha256").update(bytes).digest("hex") !== upload.preview_sha256
  ) {
    throw new Error("Uploaded preview does not match the plan");
  }
  if (!sniffPreviewType(bytes)) {
    throw new Error("A preview is a PNG, JPEG or WebP image");
  }
  await deleteObjects([key]);
  return bytes;
}

export async function finalizeTemplateUpload(params: {
  claims: GitHubActionsClaims;
  deploymentId: string;
}) {
  const { upload, template } = await loadUpload(
    params.claims,
    params.deploymentId,
  );
  if (upload.status !== "planned") {
    throw new Error("Deployment is not ready to finalize");
  }
  if (params.claims.sha !== upload.github_sha) {
    throw new Error("GitHub commit does not match this deployment");
  }
  if (new Date(upload.expires_at).getTime() <= Date.now()) {
    throw new Error("Deployment has expired");
  }
  const manifest = upload.manifest;
  const uploaded = new Set(upload.uploaded_paths);
  const reusable = await reusableFiles(template.latest_version_id);
  const stagedKey = (path: string) => `${upload.upload_prefix}/${path}`;
  const sourceKey = (path: string) => {
    if (uploaded.has(path)) return stagedKey(path);
    const file = manifest.files.find((f) => f.path === path)!;
    const key = reusable.get(`${path}\0${file.sha256}`);
    if (!key) throw new Error(`${path} was neither uploaded nor reusable`);
    return key;
  };

  try {
    await eachLimit(
      manifest.files.filter((file) => uploaded.has(file.path)),
      PUBLISH_CONCURRENCY,
      async (file) => {
        const key = stagedKey(file.path);
        const head = await s3Client.send(
          new HeadObjectCommand({ Bucket: bucket(), Key: key }),
        );
        if (head.ContentLength !== file.size) {
          throw new Error(
            `Uploaded size does not match manifest for ${file.path}`,
          );
        }
        if ((await sha256Object(key)) !== file.sha256) {
          throw new Error(
            `Uploaded checksum does not match manifest for ${file.path}`,
          );
        }
      },
    );
    await assertSiteCodeParses(manifest, sourceKey);
    const preview = await stagedPreview(upload);

    // The same files as the latest version (nothing uploaded, nothing
    // dropped): no new version, so installed sites are not offered an empty
    // update. A repository publishing several folders as templates runs
    // every one of them on each push.
    const latest = template.latest_version_id
      ? await db
          .selectFrom("board_template_versions")
          .select(["id", "version", "file_count"])
          .where("id", "=", template.latest_version_id)
          .executeTakeFirst()
      : undefined;
    if (
      latest &&
      uploaded.size === 0 &&
      latest.file_count === manifest.files.length
    ) {
      if (preview) await storeTemplatePreview(template.id, preview);
      await db
        .updateTable("board_template_uploads")
        .set({
          status: "finalized",
          version_id: latest.id,
          finalized_at: new Date(),
        })
        .where("id", "=", upload.id)
        .execute();
      return {
        version: latest.version,
        versionId: latest.id,
        unchanged: true,
        previewUpdated: preview !== null,
        deployedFiles: manifest.files.length,
        uploadedFiles: 0,
        deletedFiles: 0,
        functions: null,
      };
    }

    const result = await db.transaction().execute(async (tx) => {
      // Serialises two publishes of the same template.
      await tx
        .selectFrom("board_templates")
        .select("id")
        .where("id", "=", template.id)
        .forUpdate()
        .execute();
      const latest = await tx
        .selectFrom("board_template_versions")
        .select(sql<number>`coalesce(max(version), 0)`.as("version"))
        .where("template_id", "=", template.id)
        .executeTakeFirstOrThrow();
      const versionNumber = Number(latest.version) + 1;
      const paths = manifest.files.map((file) => file.path);
      const version = await tx
        .insertInto("board_template_versions")
        .values({
          template_id: template.id,
          version: versionNumber,
          source_path: "",
          file_count: manifest.files.length,
          size_bytes: manifest.files.reduce((sum, f) => sum + f.size, 0),
          changelog: upload.changelog,
          site_code: hasSiteCode(paths),
          github_sha: upload.github_sha,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("board_template_files")
        .values(
          manifest.files.map((file) => ({
            version_id: version.id,
            path: file.path,
            size_bytes: file.size,
            content_type: contentTypeFor(file),
            sha256: file.sha256,
          })),
        )
        .execute();
      const copied: string[] = [];
      try {
        await eachLimit(manifest.files, PUBLISH_CONCURRENCY, async (file) => {
          const target = templateFileKey(template.id, versionNumber, file.path);
          await storage.copyObject(
            sourceKey(file.path),
            target,
            contentTypeFor(file),
          );
          copied.push(target);
        });
      } catch (error) {
        await storage.deleteObjects(copied).catch(() => {});
        throw error;
      }
      await recordVersionEtags(tx, template.id, versionNumber, version.id);
      await tx
        .updateTable("board_templates")
        .set({ latest_version_id: version.id })
        .where("id", "=", template.id)
        .execute();
      await tx
        .updateTable("board_posts")
        .set({ activity_at: sql`now()` })
        .where("id", "=", template.post_id)
        .execute();
      await tx
        .updateTable("board_template_uploads")
        .set({
          status: "finalized",
          version_id: version.id,
          finalized_at: new Date(),
        })
        .where("id", "=", upload.id)
        .execute();
      await enqueueTemplatePreview(tx, version.id);
      await notifyTemplateVersion(tx, template.id, version.id);
      return {
        version: versionNumber,
        versionId: version.id,
        unchanged: false,
      };
    });

    // After the version, so a version that fails leaves the preview be.
    if (preview) await storeTemplatePreview(template.id, preview);
    await deleteObjects([...uploaded].map(stagedKey));
    return {
      ...result,
      previewUpdated: preview !== null,
      deployedFiles: manifest.files.length,
      uploadedFiles: uploaded.size,
      deletedFiles: 0,
      // A template's code runs on the sites that install it, not here.
      functions: null,
    };
  } catch (error) {
    await db
      .updateTable("board_template_uploads")
      .set({
        status: "failed",
        error_message: error instanceof Error ? error.message : String(error),
      })
      .where("id", "=", upload.id)
      .execute();
    throw error;
  }
}

export async function templateUploadStatus(params: {
  claims: GitHubActionsClaims;
  deploymentId: string;
}) {
  const { upload } = await loadUpload(params.claims, params.deploymentId);
  return {
    status: upload.status,
    error: upload.error_message,
    functions: null,
    versionId: upload.version_id,
  };
}

/** Planned uploads whose time ran out: their staged files go. */
export async function expireTemplateUploads(): Promise<number> {
  const expired = await db
    .selectFrom("board_template_uploads")
    .select(["id", "upload_prefix"])
    .where("status", "=", "planned")
    .where("expires_at", "<=", new Date())
    .execute();
  for (const upload of expired) {
    await storage.deletePrefix(`${upload.upload_prefix}/`);
    await db
      .updateTable("board_template_uploads")
      .set({
        status: "expired",
        error_message: "Deployment expired before finalize",
      })
      .where("id", "=", upload.id)
      .where("status", "=", "planned")
      .execute();
  }
  return expired.length;
}
