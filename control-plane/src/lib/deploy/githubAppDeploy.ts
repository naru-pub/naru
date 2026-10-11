import { createHash } from "node:crypto";
import { after } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { s3Client } from "@/lib/s3";
import {
  assertNoOverlappingTarget,
  normalizeTargetPrefix,
  planDeployment,
  publishPlannedDeployment,
  validateManifest,
} from "./siteDeploy";
import { filesFromArchive } from "./githubArchive";
import {
  branchHead,
  downloadArchive,
  installationRepositories,
  installationToken,
  type UserInstallation,
} from "./githubApp";

// Deploys through Naru's GitHub App (docs/github-app.md): an owner connects a
// repository on /deploys, GitHub tells Naru of each push, and Naru publishes
// the pushed commit. A push only marks its target (pending_sha); the runner
// deploys marked targets, in the request that marked them and every minute
// after (cli/run-github-deploys.ts), so a deploy that died with its process
// is picked up again.

/** How long a deploy may hold a target before the runner takes it over. */
const STALE_DEPLOY_MS = 15 * 60 * 1000;

export class DeployError extends Error {}

/**
 * Records the installations a GitHub user reaches as this Naru account's,
 * each with the repositories the user can read, replacing what it had.
 */
export async function linkInstallations(
  userId: string,
  installations: UserInstallation[],
) {
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("github_installations")
      .where("user_id", "=", userId)
      .execute();
    for (const installation of installations)
      await tx
        .insertInto("github_installations")
        .values({
          user_id: userId,
          installation_id: installation.installationId,
          account_login: installation.accountLogin,
          repository_ids: installation.repositoryIds,
        })
        .execute();
  });
}

/** The account's linked installations, with the repositories it may use. */
export async function linkedRepositories(userId: string) {
  const installations = await db
    .selectFrom("github_installations")
    .select(["installation_id", "account_login", "repository_ids"])
    .where("user_id", "=", userId)
    .orderBy("account_login")
    .execute();
  return Promise.all(
    installations.map(async (installation) => {
      const allowed = new Set(installation.repository_ids.map(String));
      const repositories = await installationRepositories(
        String(installation.installation_id),
      ).catch(() => null);
      return {
        installationId: String(installation.installation_id),
        accountLogin: installation.account_login,
        repositories:
          repositories?.filter((repository) => allowed.has(repository.id)) ??
          null,
      };
    }),
  );
}

/** Whether the account linked `installationId` and may use `repositoryId`. */
async function mayUse(
  userId: string,
  installationId: string,
  repositoryId: string,
) {
  const row = await db
    .selectFrom("github_installations")
    .select("repository_ids")
    .where("user_id", "=", userId)
    .where("installation_id", "=", installationId)
    .executeTakeFirst();
  return Boolean(row?.repository_ids.map(String).includes(repositoryId));
}

function branchName(value: unknown) {
  const branch = String(value ?? "").trim();
  if (
    !branch ||
    branch.length > 200 ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    branch.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new DeployError("브랜치 이름이 올바르지 않습니다.");
  return branch;
}

/**
 * Connects a repository the account may use to its site: `sourceDir` of
 * `branch` is published at `targetPrefix`, starting with the branch's current
 * commit. Connecting the same repository, branch and site folder again
 * updates it.
 */
export async function connectRepository(params: {
  userId: string;
  installationId: string;
  repositoryId: string;
  branch: string;
  sourceDir?: string;
  targetPrefix?: string;
}) {
  if (!(await userHasFeature(params.userId, "github_deploys")))
    throw new DeployError("GitHub 배포는 후원자 기능입니다.");
  const installationId = String(params.installationId);
  const repositoryId = String(params.repositoryId);
  if (!/^\d+$/.test(installationId) || !/^\d+$/.test(repositoryId))
    throw new DeployError("저장소를 다시 골라 주세요.");
  if (!(await mayUse(params.userId, installationId, repositoryId)))
    throw new DeployError(
      "이 저장소에 접근할 수 없습니다. GitHub 연결을 다시 확인해 주세요.",
    );
  const branch = branchName(params.branch);
  let sourceDir: string;
  let targetPrefix: string;
  try {
    sourceDir = normalizeTargetPrefix(params.sourceDir);
    targetPrefix = normalizeTargetPrefix(params.targetPrefix);
  } catch {
    throw new DeployError("폴더 경로가 올바르지 않습니다.");
  }
  const token = await installationToken(installationId, repositoryId);
  const head = await branchHead(token, repositoryId, branch).catch(() => {
    throw new DeployError(`브랜치 ${branch}를 찾지 못했습니다.`);
  });
  const ref = `refs/heads/${branch}`;
  try {
    await assertNoOverlappingTarget({
      userId: params.userId,
      targetPrefix,
      same: (target) =>
        target.installation_id !== null &&
        target.github_repository_id === repositoryId &&
        target.github_ref === ref &&
        target.target_prefix === targetPrefix,
    });
  } catch (error) {
    throw new DeployError((error as Error).message);
  }
  const values = {
    installation_id: installationId,
    github_repository: head.fullName,
    github_repository_id: repositoryId,
    source_dir: sourceDir,
    enabled: true,
    delete_removed_files: true,
    pending_sha: head.sha,
    pending_at: new Date(),
    last_error: null,
    updated_at: new Date(),
  };
  const target = await db
    .insertInto("github_deploy_targets")
    .values({
      user_id: params.userId,
      github_ref: ref,
      target_prefix: targetPrefix,
      ...values,
    })
    .onConflict((conflict) =>
      conflict
        .columns([
          "user_id",
          "github_repository",
          "github_ref",
          "target_prefix",
        ])
        .doUpdateSet(values),
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: target.id };
}

/** "Deploy now": the branch's current commit, for a target of the account's. */
export async function redeploy(userId: string, targetId: string) {
  const target = await db
    .selectFrom("github_deploy_targets")
    .select([
      "installation_id",
      "github_repository_id",
      "github_ref",
      "enabled",
    ])
    .where("id", "=", targetId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!target?.enabled || target.installation_id === null)
    throw new DeployError("연결된 저장소를 찾지 못했습니다.");
  const installationId = String(target.installation_id);
  const repositoryId = String(target.github_repository_id);
  const token = await installationToken(installationId, repositoryId);
  const head = await branchHead(
    token,
    repositoryId,
    target.github_ref.replace(/^refs\/heads\//, ""),
  );
  await db
    .updateTable("github_deploy_targets")
    .set({ pending_sha: head.sha, pending_at: new Date() })
    .where("id", "=", targetId)
    .execute();
}

/** A push GitHub reported: marks every target it deploys. */
export async function queuePush(push: {
  installationId: string;
  repositoryId: string;
  repository: string;
  ref: string;
  sha: string;
}) {
  const marked = await db
    .updateTable("github_deploy_targets")
    .set({
      pending_sha: push.sha,
      pending_at: new Date(),
      // A renamed repository keeps its id; its name follows.
      github_repository: push.repository,
    })
    .where("installation_id", "=", push.installationId)
    .where("github_repository_id", "=", push.repositoryId)
    .where("github_ref", "=", push.ref)
    .where("enabled", "=", true)
    .executeTakeFirst();
  return Number(marked.numUpdatedRows);
}

/** An installation removed, or repositories taken out of it. */
export async function forgetInstallation(
  installationId: string,
  repositoryIds?: string[],
) {
  let targets = db
    .updateTable("github_deploy_targets")
    .set({ enabled: false, pending_sha: null, updated_at: new Date() })
    .where("installation_id", "=", installationId);
  if (repositoryIds)
    targets = targets.where("github_repository_id", "in", repositoryIds);
  await targets.execute();
  if (!repositoryIds) {
    await db
      .deleteFrom("github_installations")
      .where("installation_id", "=", installationId)
      .execute();
    return;
  }
  await db
    .updateTable("github_installations")
    .set({
      repository_ids: sql`array(select unnest(repository_ids) except select unnest(${sql.val(repositoryIds)}::bigint[]))`,
      updated_at: new Date(),
    })
    .where("installation_id", "=", installationId)
    .execute();
}

/** Takes one marked target for this process, or none. */
async function claimTarget() {
  const stale = new Date(Date.now() - STALE_DEPLOY_MS);
  const { rows } = await sql<{
    id: string;
    user_id: string;
    installation_id: string;
    github_repository: string;
    github_repository_id: string;
    github_ref: string;
    target_prefix: string;
    source_dir: string;
    last_manifest: unknown;
    pending_sha: string;
  }>`
    update github_deploy_targets set deploying_at = now()
    where id = (
      select id from github_deploy_targets
      where pending_sha is not null and enabled and installation_id is not null
        and (deploying_at is null or deploying_at < ${stale})
      order by pending_at
      for update skip locked
      limit 1
    )
    returning id, user_id, installation_id::text, github_repository,
      github_repository_id, github_ref, target_prefix, source_dir,
      last_manifest, pending_sha
  `.execute(db);
  return rows[0] ?? null;
}

type ClaimedTarget = NonNullable<Awaited<ReturnType<typeof claimTarget>>>;

/** Fetches the target's pending commit and publishes it. */
async function deploy(target: ClaimedTarget) {
  if (!(await userHasFeature(target.user_id, "github_deploys")))
    throw new DeployError("GitHub 배포는 후원자 기능입니다.");
  if (
    !(await mayUse(
      target.user_id,
      target.installation_id,
      target.github_repository_id,
    ))
  )
    throw new DeployError(
      "이 저장소에 더는 접근할 수 없습니다. GitHub 연결을 다시 확인해 주세요.",
    );
  const token = await installationToken(
    target.installation_id,
    target.github_repository_id,
  );
  const archive = await downloadArchive(
    token,
    target.github_repository_id,
    target.pending_sha,
  );
  const { files, skipped } = await filesFromArchive(archive, target.source_dir);
  const byPath = new Map(files.map((file) => [file.path, file.data]));
  let manifest;
  try {
    manifest = validateManifest({
      files: files.map((file) => ({
        path: file.path,
        size: file.data.byteLength,
        sha256: createHash("sha256").update(file.data).digest("hex"),
      })),
    });
  } catch (error) {
    throw new DeployError(
      (error as Error).message === "Deploy manifest must include index.html"
        ? `${target.source_dir ? `${target.source_dir}/` : ""}index.html이 없습니다.`
        : (error as Error).message,
    );
  }
  const plan = await planDeployment({
    target,
    manifest,
    repository: target.github_repository,
    repositoryId: target.github_repository_id,
    ref: target.github_ref,
    sha: target.pending_sha,
    skippedPaths: skipped,
  });
  for (const path of plan.uploadedPaths)
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: `${plan.uploadPrefix}/${path}`,
        Body: byPath.get(path)!,
      }),
    );
  return publishPlannedDeployment(plan.id);
}

/**
 * Deploys marked targets until none is left, or `limit`. A failure is kept as
 * the target's last_error and its mark cleared: the next push, or "deploy
 * now", tries again. A push that arrived during the deploy keeps its mark.
 */
export async function runPendingDeploys({ limit = 20 } = {}) {
  let deployed = 0;
  for (let n = 0; n < limit; n += 1) {
    const target = await claimTarget();
    if (!target) break;
    let error: string | null = null;
    try {
      await deploy(target);
      deployed += 1;
    } catch (failure) {
      error =
        failure instanceof Error ? failure.message : "배포하지 못했습니다.";
      if (!(failure instanceof DeployError))
        console.error("[github-app] deploy failed", target.id, failure);
    }
    await db
      .updateTable("github_deploy_targets")
      .set((eb) => ({
        deploying_at: null,
        last_error: error,
        pending_sha: eb
          .case()
          .when("pending_sha", "=", target.pending_sha)
          .then(null)
          .else(eb.ref("pending_sha"))
          .end(),
      }))
      .where("id", "=", target.id)
      .execute();
  }
  return deployed;
}

/**
 * Starts the runner once the response is sent; outside a request (a test, a
 * script) it just starts. The minute job finishes whatever this does not.
 */
export function deployInBackground() {
  const run = () =>
    runPendingDeploys().then(
      () => undefined,
      (error) => console.error("[github-app] deploys failed", error),
    );
  try {
    after(run);
  } catch {
    void run();
  }
}
