// Template versions a GitHub Actions workflow publishes, through the same
// three calls as a site deploy (/api/deploy/github/plan, finalize, status)
// with `template` in place of `site`:
//
// 1. plan: the run's OIDC token must name the template's repository and
//    ref. Files the previous version had with the same sha256 are reused;
//    the rest get signed upload URLs to a staging prefix.
// 2. finalize: the staged files are checked against the manifest, the site
//    code in them must parse, and the version is published: copied under
//    _templates/<id>/v<n>/, with each file's sha256 and ETag, a preview and
//    automatic updates queued.
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
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
  formatBytes,
} from "./constants";
import { enqueueTemplateUpdates, recordVersionEtags } from "./installs";
import { templateFileKey } from "./preview";
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
  templateId: string;
  manifest: unknown;
  changelog?: unknown;
}) {
  const template = await findGitHubTemplate(params.templateId);
  if (!(await userHasFeature(template.user_id, "github_deploys"))) {
    throw new Error("GitHub deploys are available to supporters only");
  }
  assertGitHubClaimsAllowed(params.claims, {
    github_repository: template.github_repository,
    github_repository_id: template.github_repository_id,
    github_ref: template.github_ref,
  });
  const manifest = validateTemplateManifest(params.manifest);
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
  return {
    deploymentId: id,
    expiresAt: expiresAt.toISOString(),
    uploads,
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
      await enqueueTemplateUpdates(tx, template.id, version.id);
      return { version: versionNumber, versionId: version.id };
    });

    await deleteObjects([...uploaded].map(stagedKey));
    return {
      ...result,
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
