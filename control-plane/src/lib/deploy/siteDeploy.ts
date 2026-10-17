import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { purgeSiteFiles } from "@/lib/cache-purge";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomBytes } from "crypto";
import * as Sentry from "@sentry/nextjs";
import { sql } from "kysely";
import { db, recordSiteEdit } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { extractHtmlTitle } from "@/lib/html";
import {
  ALLOWED_FILE_EXTENSIONS,
  FILE_EXTENSION_MIMETYPE_MAP,
} from "@/lib/const";
import { s3Client } from "@/lib/s3";
import { getUserHomeDirectory, getUserObjectKey } from "@/lib/site-urls";
import { GitHubActionsClaims } from "./githubOidc";

const MAX_DEPLOY_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DEPLOYMENT_TTL_MS = 60 * 60 * 1000;
const UPLOAD_URL_TTL_SECONDS = 15 * 60;
// Staged files are checked and copied this many at a time: one by one, a
// deploy of a few hundred files outlasts Cloudflare's 100-second limit on the
// finalize request.
const PUBLISH_CONCURRENCY = 16;

async function eachLimit<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<unknown>,
) {
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length)
        await run(items[next++]).catch((error) => {
          failed = true;
          throw error;
        });
    }),
  );
}

export type DeployManifestFile = {
  path: string;
  sha256: string;
  size: number;
  contentType?: string;
};

export type DeployManifest = {
  files: DeployManifestFile[];
};

export function changedManifestPaths(
  previousFiles: DeployManifestFile[],
  nextFiles: DeployManifestFile[],
) {
  const previousFilesByPath = new Map(
    previousFiles.map((file) => [file.path, file]),
  );
  return nextFiles
    .filter((file) => {
      const previous = previousFilesByPath.get(file.path);
      return (
        !previous ||
        previous.sha256 !== file.sha256 ||
        previous.size !== file.size ||
        previous.contentType !== file.contentType
      );
    })
    .map((file) => file.path);
}

type UserRow = {
  id: string;
};

function deploymentId() {
  return randomBytes(24).toString("base64url");
}

function assertSha256(value: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Invalid sha256 value");
  }
}

export function normalizeDeployPath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.length > 1000) {
    throw new Error("Invalid file path");
  }
  if (normalized.includes("//")) {
    throw new Error("File path contains empty segments");
  }
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Path traversal detected");
  }

  const extension = normalized.split(".").pop()?.toLowerCase();
  if (!extension || !ALLOWED_FILE_EXTENSIONS.includes(extension)) {
    throw new Error(`Unsupported file extension for ${normalized}`);
  }

  return normalized;
}

export function normalizeTargetPrefix(prefix: string | null | undefined) {
  const raw = (prefix ?? "").replaceAll("\\", "/").trim();
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return "";
  if (normalized.length > 1000) {
    throw new Error("Target prefix is too long");
  }
  if (
    normalized.includes("//") ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Invalid target prefix");
  }
  return normalized;
}

function publicPath(targetPrefix: string, path: string) {
  return targetPrefix ? `${targetPrefix}/${path}` : path;
}

function contentTypeFor(file: DeployManifestFile) {
  if (file.contentType) return file.contentType;
  return FILE_EXTENSION_MIMETYPE_MAP[file.path.split(".").pop()!.toLowerCase()];
}

export function validateManifest(input: unknown): DeployManifest {
  if (
    !input ||
    typeof input !== "object" ||
    !Array.isArray((input as any).files)
  ) {
    throw new Error("Manifest files are required");
  }

  const seen = new Set<string>();
  const files = (input as any).files.map((file: any) => {
    if (!file || typeof file !== "object") {
      throw new Error("Invalid manifest file");
    }
    const path = normalizeDeployPath(String(file.path ?? ""));
    if (seen.has(path)) {
      throw new Error(`Duplicate manifest path: ${path}`);
    }
    seen.add(path);

    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid size for ${path}`);
    }
    if (size > MAX_DEPLOY_FILE_SIZE_BYTES) {
      throw new Error(`File is too large: ${path}`);
    }

    const sha256 = String(file.sha256 ?? "").toLowerCase();
    assertSha256(sha256);

    return {
      path,
      sha256,
      size,
      contentType:
        typeof file.contentType === "string" && file.contentType
          ? file.contentType
          : undefined,
    };
  }) as DeployManifestFile[];

  if (!files.some((file) => file.path === "index.html")) {
    throw new Error("Deploy manifest must include index.html");
  }

  return { files };
}

function manifestFiles(value: unknown): DeployManifestFile[] {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as any).files)
  ) {
    return [];
  }
  return (value as any).files
    .filter((file: any) => file && typeof file.path === "string")
    .map((file: any) => ({
      path: normalizeDeployPath(file.path),
      sha256: String(file.sha256 ?? ""),
      size: Number(file.size ?? 0),
      contentType:
        typeof file.contentType === "string" ? file.contentType : undefined,
    }));
}

// jsonb columns take JSON text. Handing the driver a JS value instead only
// looks like it works: it stringifies an object, but renders an array as a
// Postgres array literal -- {"a","b"} -- which jsonb rejects outright. An
// empty array survives as {}, so a column that is usually empty can sit
// wrong for a long time and fail the first time it carries anything.
const asJsonb = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

async function calculateUserHomeDirectorySize(loginName: string) {
  const prefix = `${getUserHomeDirectory(loginName)}/`;
  let totalSize = 0;
  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET_NAME!,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    totalSize +=
      response.Contents?.reduce((sum, object) => sum + (object.Size || 0), 0) ??
      0;
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return totalSize;
}

async function updateUserHomeDirectorySize(userId: string, loginName: string) {
  const directorySize = await calculateUserHomeDirectorySize(loginName);
  const now = new Date();

  await db
    .updateTable("users")
    .set({
      home_directory_size_bytes: directorySize,
      home_directory_size_bytes_updated_at: now,
    })
    .where("id", "=", userId)
    .execute();

  return directorySize;
}

async function deleteObjects(keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length === 0) continue;

    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
        },
      }),
    );
  }
}

async function readObjectText(key: string) {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: key,
    }),
  );
  return response.Body?.transformToString() ?? "";
}

async function sha256Object(key: string) {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: key,
    }),
  );
  const bytes = await response.Body?.transformToByteArray();
  return createHash("sha256")
    .update(Buffer.from(bytes ?? []))
    .digest("hex");
}

function assertGitHubClaimsAllowed(
  claims: GitHubActionsClaims,
  target: {
    github_repository: string;
    github_repository_id?: string | null;
    github_ref: string;
  },
) {
  if (claims.repository !== target.github_repository) {
    throw new Error("GitHub repository is not allowed for this target");
  }
  if (
    target.github_repository_id &&
    claims.repository_id !== target.github_repository_id
  ) {
    throw new Error(
      "GitHub repository identity is not allowed for this target",
    );
  }
  if (claims.ref !== target.github_ref) {
    throw new Error("GitHub ref is not allowed for this target");
  }
  // GitHub permits repositories and organizations to customize the subject.
  // The signed repository and ref claims above are the authorization boundary,
  // so requiring one particular subject template would reject valid callers.
}

export async function createGitHubDeploymentPlan(params: {
  claims: GitHubActionsClaims;
  site: string;
  targetPrefix?: string | null;
  manifest: unknown;
}) {
  const targetPrefix = normalizeTargetPrefix(params.targetPrefix);
  const manifest = validateManifest(params.manifest);

  const target = await db
    .selectFrom("github_deploy_targets")
    .innerJoin("users", "users.id", "github_deploy_targets.user_id")
    .select([
      "github_deploy_targets.id",
      "github_deploy_targets.user_id",
      "github_deploy_targets.github_repository",
      "github_deploy_targets.github_repository_id",
      "github_deploy_targets.github_ref",
      "github_deploy_targets.target_prefix",
      "github_deploy_targets.last_manifest",
      "users.login_name",
    ])
    .where("users.login_name", "=", params.site)
    .where(
      "github_deploy_targets.github_repository",
      "=",
      params.claims.repository,
    )
    .where("github_deploy_targets.github_ref", "=", params.claims.ref)
    .where("github_deploy_targets.target_prefix", "=", targetPrefix)
    .where("github_deploy_targets.enabled", "=", true)
    // A repository connected through the App is deployed by Naru, not by a
    // workflow, which would otherwise publish over it on the same push.
    .where("github_deploy_targets.installation_id", "is", null)
    .executeTakeFirst();

  if (!target) {
    throw new Error("No enabled GitHub deploy target matches this request");
  }

  if (!(await userHasFeature(target.user_id, "github_deploys"))) {
    throw new Error("GitHub deploys are available to supporters only");
  }

  assertGitHubClaimsAllowed(params.claims, target);

  const { id, uploadPrefix, uploadedPaths, deletedPaths, expiresAt } =
    await planDeployment({
      target,
      manifest,
      repository: params.claims.repository,
      repositoryId: params.claims.repository_id,
      ref: params.claims.ref,
      sha: params.claims.sha,
    });
  const uploadedPathSet = new Set(uploadedPaths);

  const uploads = await Promise.all(
    manifest.files
      .filter((file) => uploadedPathSet.has(file.path))
      .map(async (file) => {
        const key = `${uploadPrefix}/${file.path}`;
        const url = await getSignedUrl(
          s3Client as any,
          new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: key,
          }) as any,
          { expiresIn: UPLOAD_URL_TTL_SECONDS },
        );

        return {
          path: file.path,
          method: "PUT",
          url,
          headers: {},
        };
      }),
  );

  return {
    deploymentId: id,
    expiresAt: expiresAt.toISOString(),
    uploads,
    deletedPaths,
  };
}

/**
 * Records a planned deployment of `manifest` to `target`: which files changed
 * since the target's last deploy (only those are uploaded, to a staging
 * prefix) and which are gone. Claims the target's next generation, so an older
 * deployment can no longer publish over it. Shared by Actions deploys (the
 * workflow uploads) and App deploys (Naru uploads).
 */
export async function planDeployment(params: {
  target: {
    id: string;
    user_id: string;
    target_prefix: string;
    last_manifest: unknown;
  };
  manifest: DeployManifest;
  repository: string;
  repositoryId: string;
  ref: string;
  sha: string;
  skippedPaths?: string[];
}) {
  const { target, manifest } = params;
  const targetPrefix = target.target_prefix;
  const previousFiles = manifestFiles(target.last_manifest);

  const previousPaths = new Set(previousFiles.map((file) => file.path));
  const nextPaths = new Set(manifest.files.map((file) => file.path));
  const uploadedPaths = changedManifestPaths(previousFiles, manifest.files);
  const deletedPaths = [...previousPaths].filter(
    (path) => !nextPaths.has(path),
  );

  const id = deploymentId();
  const uploadPrefix = `__deploy_uploads/${target.user_id}/${id}`;
  const expiresAt = new Date(Date.now() + DEPLOYMENT_TTL_MS);
  const claimedTarget = await db
    .updateTable("github_deploy_targets")
    .set((eb) => ({
      deploy_generation: eb("deploy_generation", "+", 1),
      github_repository_id: params.repositoryId,
      updated_at: new Date(),
    }))
    .where("id", "=", target.id)
    .where("enabled", "=", true)
    .where((eb) =>
      eb.or([
        eb("github_repository_id", "is", null),
        eb("github_repository_id", "=", params.repositoryId),
      ]),
    )
    .returning("deploy_generation")
    .executeTakeFirst();
  if (!claimedTarget) {
    throw new Error(
      "Deploy target was disabled or is bound to a different GitHub repository identity",
    );
  }

  await db
    .insertInto("github_deployments")
    .values({
      id,
      target_id: target.id,
      user_id: target.user_id,
      status: "planned",
      github_repository: params.repository,
      github_repository_id: params.repositoryId,
      github_ref: params.ref,
      github_sha: params.sha,
      target_prefix: targetPrefix,
      upload_prefix: uploadPrefix,
      delete_removed_files: true,
      manifest: asJsonb(manifest),
      deleted_paths: asJsonb(deletedPaths),
      uploaded_paths: asJsonb(uploadedPaths),
      deploy_generation: claimedTarget.deploy_generation,
      expires_at: expiresAt,
      skipped_paths: asJsonb(params.skippedPaths ?? []),
    })
    .execute();

  return { id, uploadPrefix, uploadedPaths, deletedPaths, expiresAt };
}

/** A deployment, with what publishing it checks against its target. */
function loadDeployment(id: string) {
  return db
    .selectFrom("github_deployments")
    .innerJoin("users", "users.id", "github_deployments.user_id")
    .innerJoin(
      "github_deploy_targets",
      "github_deploy_targets.id",
      "github_deployments.target_id",
    )
    .select([
      "github_deployments.id",
      "github_deployments.target_id",
      "github_deployments.user_id",
      "github_deployments.status",
      "github_deployments.github_repository",
      "github_deployments.github_repository_id",
      "github_deployments.github_ref",
      "github_deployments.github_sha",
      "github_deployments.target_prefix",
      "github_deployments.upload_prefix",
      "github_deployments.manifest",
      "github_deployments.deleted_paths",
      "github_deployments.uploaded_paths",
      "github_deployments.deploy_generation",
      "github_deployments.expires_at",
      "github_deployments.error_message",
      "github_deployments.functions_status",
      "github_deployments.functions_error",
      "github_deploy_targets.enabled",
      "github_deploy_targets.github_repository_id as current_github_repository_id",
      "github_deploy_targets.deploy_generation as current_deploy_generation",
      "users.login_name",
    ])
    .where("github_deployments.id", "=", id)
    .executeTakeFirst();
}
type LoadedDeployment = NonNullable<Awaited<ReturnType<typeof loadDeployment>>>;

export async function finalizeGitHubDeployment(params: {
  claims: GitHubActionsClaims;
  deploymentId: string;
}) {
  const deployment = await loadDeployment(params.deploymentId);
  if (!deployment) {
    throw new Error("Deployment was not found");
  }
  if (
    deployment.github_repository_id !== params.claims.repository_id ||
    deployment.current_github_repository_id !== params.claims.repository_id
  ) {
    throw new Error(
      "GitHub repository identity does not match this deployment",
    );
  }
  assertGitHubClaimsAllowed(params.claims, deployment);
  if (params.claims.sha !== deployment.github_sha) {
    throw new Error("GitHub commit does not match this deployment");
  }
  // The site's code activates in its durable task: activation applies the
  // release's migrations after a restore point, which can take minutes. The
  // workflow asks how it went (githubDeploymentStatus).
  return publishDeployment(deployment, { deferFunctions: true });
}

/**
 * What a workflow's finalized deployment published, and whether the site
 * code it changed is active yet: `functions` is null when it changed none,
 * else `activating` until the durable task activates it (`active`) or the
 * site refuses it for good (`refused`, with why, as 422 migration_failed).
 */
export async function githubDeploymentStatus(params: {
  claims: GitHubActionsClaims;
  deploymentId: string;
}) {
  const deployment = await loadDeployment(params.deploymentId);
  if (
    !deployment ||
    deployment.github_repository_id !== params.claims.repository_id
  ) {
    throw new Error("Deployment was not found");
  }
  assertGitHubClaimsAllowed(params.claims, deployment);
  return {
    status: deployment.status,
    error: deployment.error_message,
    functions: deployment.functions_status
      ? {
          status: deployment.functions_status,
          ...(deployment.functions_error
            ? { error: deployment.functions_error }
            : {}),
        }
      : null,
  };
}

/**
 * Publishes a planned deployment whose changed files are in its staging
 * prefix: checks them against the manifest, copies them into the site,
 * deletes what the commit no longer has, and records the target's new state.
 * Refuses a deployment a newer one has overtaken. Shared by Actions and App
 * deploys; the caller has checked who may publish it.
 */
export async function publishPlannedDeployment(deploymentId: string) {
  const deployment = await loadDeployment(deploymentId);
  if (!deployment) throw new Error("Deployment was not found");
  return publishDeployment(deployment);
}

async function publishDeployment(
  deployment: LoadedDeployment,
  options: { deferFunctions?: boolean } = {},
) {
  if (deployment.status !== "planned") {
    throw new Error("Deployment is not ready to finalize");
  }
  if (!deployment.enabled) {
    throw new Error("Deploy target is disabled");
  }
  if (deployment.current_deploy_generation !== deployment.deploy_generation) {
    throw new Error(
      "A newer deployment has already updated this target; start a new deployment",
    );
  }
  if (new Date(deployment.expires_at).getTime() <= Date.now()) {
    throw new Error("Deployment has expired");
  }

  const manifest = validateManifest(deployment.manifest);
  const deletedPaths = Array.isArray(deployment.deleted_paths)
    ? deployment.deleted_paths.map((path) => normalizeDeployPath(String(path)))
    : [];
  const uploadedPaths = Array.isArray(deployment.uploaded_paths)
    ? deployment.uploaded_paths.map((path) => normalizeDeployPath(String(path)))
    : [];
  const uploadedPathSet = new Set(uploadedPaths);
  if (uploadedPathSet.size !== uploadedPaths.length) {
    throw new Error("Deployment contains duplicate uploaded paths");
  }
  const manifestPathSet = new Set(manifest.files.map((file) => file.path));
  if (uploadedPaths.some((path) => !manifestPathSet.has(path))) {
    throw new Error(
      "Deployment contains an uploaded path outside its manifest",
    );
  }

  const uploadedFiles = manifest.files.filter((file) =>
    uploadedPathSet.has(file.path),
  );
  try {
    await eachLimit(uploadedFiles, PUBLISH_CONCURRENCY, async (file) => {
      const stagingKey = `${deployment.upload_prefix}/${file.path}`;
      const head = await s3Client.send(
        new HeadObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          Key: stagingKey,
        }),
      );

      if (head.ContentLength !== file.size) {
        throw new Error(
          `Uploaded size does not match manifest for ${file.path}`,
        );
      }
      if ((await sha256Object(stagingKey)) !== file.sha256) {
        throw new Error(
          `Uploaded checksum does not match manifest for ${file.path}`,
        );
      }
    });

    const rootIndex = manifest.files.find((file) => file.path === "index.html");
    const rootIndexKey =
      rootIndex &&
      uploadedPathSet.has(rootIndex.path) &&
      deployment.target_prefix === ""
        ? `${deployment.upload_prefix}/${rootIndex.path}`
        : null;
    const siteTitle = rootIndexKey
      ? extractHtmlTitle(await readObjectText(rootIndexKey))
      : null;

    await eachLimit(uploadedFiles, PUBLISH_CONCURRENCY, async (file) => {
      const stagingKey = `${deployment.upload_prefix}/${file.path}`;
      const targetPath = publicPath(deployment.target_prefix, file.path);
      const publicKey = getUserObjectKey(deployment.login_name, targetPath);

      await s3Client.send(
        new CopyObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          CopySource: `${process.env.S3_BUCKET_NAME!}/${encodeURIComponent(
            stagingKey,
          )}`,
          Key: publicKey,
          ContentType: contentTypeFor(file),
          Metadata: { sha256: file.sha256 },
          MetadataDirective: "REPLACE",
        }),
      );
    });

    const publicDeleteKeys = deletedPaths.map((path) =>
      getUserObjectKey(
        deployment.login_name,
        publicPath(deployment.target_prefix, path),
      ),
    );
    await deleteObjects(publicDeleteKeys);

    const releases = await purgeSiteFiles(
      deployment.login_name,
      [
        ...manifest.files.map((file) =>
          publicPath(deployment.target_prefix, file.path),
        ),
        ...deletedPaths.map((path) =>
          publicPath(deployment.target_prefix, path),
        ),
      ],
      options.deferFunctions ? { deploymentId: deployment.id } : {},
    );
    const release = options.deferFunctions
      ? releases.get(deployment.login_name)
      : undefined;

    await deleteObjects(
      manifest.files.map((file) => `${deployment.upload_prefix}/${file.path}`),
    );

    await recordSiteEdit(deployment.user_id);

    if (deployment.target_prefix === "" && rootIndexKey) {
      await db
        .updateTable("users")
        .set({ site_title: siteTitle })
        .where("id", "=", deployment.user_id)
        .execute();
    }

    const directorySize = await updateUserHomeDirectorySize(
      deployment.user_id,
      deployment.login_name,
    );

    await db
      .updateTable("github_deploy_targets")
      .set({
        last_manifest: asJsonb(manifest),
        last_github_sha: deployment.github_sha,
        last_deployed_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", deployment.target_id)
      .execute();

    await db
      .updateTable("github_deployments")
      .set({
        status: "finalized",
        finalized_at: new Date(),
      })
      .where("id", "=", deployment.id)
      .execute();

    return {
      directorySize,
      deployedFiles: manifest.files.length,
      uploadedFiles: uploadedPaths.length,
      deletedFiles: deletedPaths.length,
      // Site code still activating: poll /api/deploy/github/status.
      functions: release ? { status: "activating" as const } : null,
    };
  } catch (error) {
    await db
      .updateTable("github_deployments")
      .set({
        status: "failed",
        error_message: error instanceof Error ? error.message : String(error),
      })
      .where("id", "=", deployment.id)
      .execute();
    throw error;
  }
}

const sitePath = (prefix: string) => (prefix ? `/${prefix}/` : "/");

/**
 * Refuses a deploy target whose site folder is, or is inside or around, the
 * folder of another enabled target of the account: each deletes only what it
 * published, but where both publish the same path the last one wins, and two
 * kinds of deploy on one folder would take turns replacing each other's
 * files. Saving the same target again (`same`) is not a conflict.
 */
export async function assertNoOverlappingTarget(params: {
  userId: string;
  targetPrefix: string;
  same: (target: {
    github_repository: string;
    github_repository_id: string | null;
    github_ref: string;
    target_prefix: string;
    installation_id: string | null;
  }) => boolean;
}) {
  const targets = await db
    .selectFrom("github_deploy_targets")
    .select([
      "github_repository",
      "github_repository_id",
      "github_ref",
      "target_prefix",
      "installation_id",
    ])
    .where("user_id", "=", params.userId)
    .where("enabled", "=", true)
    .execute();
  const prefix = params.targetPrefix;
  for (const target of targets) {
    const row = {
      ...target,
      installation_id:
        target.installation_id === null ? null : String(target.installation_id),
    };
    if (params.same(row)) continue;
    const other = target.target_prefix;
    if (
      other === prefix ||
      other === "" ||
      prefix === "" ||
      other.startsWith(`${prefix}/`) ||
      prefix.startsWith(`${other}/`)
    )
      throw new Error(
        other === prefix && row.installation_id === null
          ? `${target.github_repository}이(가) 이미 GitHub Actions로 사이트 폴더 ${sitePath(other)}에 배포하고 있습니다. 고급에서 먼저 지우세요.`
          : `${target.github_repository}이(가) 이미 사이트 폴더 ${sitePath(other)}에 배포하고 있어, ${sitePath(prefix)}와 겹칩니다. 겹치지 않는 폴더를 고르거나 그 배포를 먼저 지우세요.`,
      );
  }
}

export async function upsertGitHubDeployTarget(params: {
  user: UserRow;
  githubRepository: string;
  githubRef: string;
  targetPrefix?: string | null;
}) {
  const githubRepository = params.githubRepository.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)) {
    throw new Error("GitHub repository must be in owner/repo format");
  }
  const githubRef = params.githubRef.trim();
  if (
    !githubRef.startsWith("refs/heads/") &&
    !githubRef.startsWith("refs/tags/")
  ) {
    throw new Error(
      "GitHub ref must be a full refs/heads/* or refs/tags/* ref",
    );
  }
  const targetPrefix = normalizeTargetPrefix(params.targetPrefix);
  await assertNoOverlappingTarget({
    userId: params.user.id,
    targetPrefix,
    same: (target) =>
      target.installation_id === null &&
      target.github_repository === githubRepository &&
      target.github_ref === githubRef &&
      target.target_prefix === targetPrefix,
  });

  await db
    .insertInto("github_deploy_targets")
    .values({
      user_id: params.user.id,
      github_repository: githubRepository,
      github_ref: githubRef,
      target_prefix: targetPrefix,
      delete_removed_files: true,
      enabled: true,
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc
        .columns([
          "user_id",
          "github_repository",
          "github_ref",
          "target_prefix",
        ])
        .doUpdateSet({
          delete_removed_files: true,
          enabled: true,
          // A disconnected App target of the same repository becomes a
          // workflow's: Naru no longer deploys it on push.
          installation_id: null,
          pending_sha: null,
          last_error: null,
          updated_at: new Date(),
        }),
    )
    .execute();
}
