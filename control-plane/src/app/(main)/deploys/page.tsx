import { redirect } from "next/navigation";

import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { sql } from "kysely";
import GitHubDeployTargetsCard from "../account/GitHubDeployTargetsCard";
import GitHubAppCard, { type AppTarget } from "./GitHubAppCard";
import GitHubDeploymentsCard from "./GitHubDeploymentsCard";

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function manifestFileCount(value: unknown) {
  if (!value || typeof value !== "object" || !("files" in value)) return 0;
  return arrayLength((value as { files?: unknown }).files);
}

export default async function DeploysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { github } = await searchParams;
  const { user } = await validateRequest();

  if (!user) {
    redirect("/");
  }

  if (!(await userHasFeature(user.id, "github_deploys"))) {
    redirect("/account");
  }

  const githubDeployTargetRows = await db
    .selectFrom("github_deploy_targets")
    .select([
      "id",
      "github_repository",
      "github_ref",
      "target_prefix",
      "enabled",
      "last_github_sha",
      "last_deployed_at",
    ])
    .where("user_id", "=", user.id)
    .where("enabled", "=", true)
    .where("installation_id", "is", null)
    .orderBy("created_at", "desc")
    .execute();
  // Repositories connected through Naru's GitHub App, each with what its
  // latest deployment left out.
  const appTargets: AppTarget[] = (
    await db
      .selectFrom("github_deploy_targets as t")
      .select((eb) => [
        "t.id",
        "t.github_repository",
        "t.github_ref",
        "t.source_dir",
        "t.target_prefix",
        "t.pending_sha",
        "t.last_error",
        "t.last_github_sha",
        "t.last_deployed_at",
        eb
          .selectFrom("github_deployments as d")
          .select(sql<number>`jsonb_array_length(d.skipped_paths)`.as("count"))
          .whereRef("d.target_id", "=", "t.id")
          .where("d.status", "=", "finalized")
          .orderBy("d.created_at", "desc")
          .limit(1)
          .as("skipped_count"),
      ])
      .where("t.user_id", "=", user.id)
      .where("t.enabled", "=", true)
      .where("t.installation_id", "is not", null)
      .orderBy("t.created_at", "desc")
      .execute()
  ).map((target) => ({
    id: target.id,
    githubRepository: target.github_repository,
    branch: target.github_ref.replace(/^refs\/heads\//, ""),
    sourceDir: target.source_dir,
    targetPrefix: target.target_prefix,
    pending: target.pending_sha !== null,
    lastError: target.last_error,
    lastGithubSha: target.last_github_sha,
    lastDeployedAt: target.last_deployed_at?.toISOString() ?? null,
    skippedCount: Number(target.skipped_count ?? 0),
  }));
  const githubDeployTargets = githubDeployTargetRows.map((target) => ({
    id: target.id,
    githubRepository: target.github_repository,
    githubRef: target.github_ref,
    targetPrefix: target.target_prefix,
    enabled: target.enabled,
    lastGithubSha: target.last_github_sha,
    lastDeployedAt: target.last_deployed_at?.toISOString() ?? null,
  }));
  const githubDeploymentRows = await db
    .selectFrom("github_deployments")
    .select([
      "id",
      "status",
      "github_repository",
      "github_ref",
      "github_sha",
      "target_prefix",
      "manifest",
      "uploaded_paths",
      "deleted_paths",
      "error_message",
      "created_at",
      "finalized_at",
    ])
    .where("user_id", "=", user.id)
    .orderBy("created_at", "desc")
    .limit(20)
    .execute();
  const githubDeployments = githubDeploymentRows.map((deployment) => ({
    id: deployment.id,
    status: deployment.status,
    githubRepository: deployment.github_repository,
    githubRef: deployment.github_ref,
    githubSha: deployment.github_sha,
    targetPrefix: deployment.target_prefix,
    fileCount: manifestFileCount(deployment.manifest),
    uploadedFileCount: arrayLength(deployment.uploaded_paths),
    deletedFileCount: arrayLength(deployment.deleted_paths),
    errorMessage: deployment.error_message,
    createdAt: deployment.created_at.toISOString(),
    finalizedAt: deployment.finalized_at?.toISOString() ?? null,
  }));

  // An account that deploys with an Actions workflow sees that first, with
  // the App connection collapsed under it; otherwise workflow deploys are
  // kept out of the way, for sites with a build step. Either way the
  // deployment log, which covers both, follows the one in use.
  const usesWorkflow = githubDeployTargets.length > 0;
  const appCard = (
    <GitHubAppCard
      loginName={user.loginName}
      targets={appTargets}
      notice={typeof github === "string" ? github : null}
      collapsed={usesWorkflow}
    />
  );
  const workflowCard = (
    <GitHubDeployTargetsCard
      loginName={user.loginName}
      targets={githubDeployTargets}
    />
  );
  const deploymentsCard = (
    <GitHubDeploymentsCard deployments={githubDeployments} />
  );

  return (
    <div className="bg-background min-h-screen">
      <div className="mx-auto max-w-4xl space-y-8 p-6">
        {usesWorkflow ? (
          <>
            {workflowCard}
            {appCard}
            {deploymentsCard}
          </>
        ) : (
          <>
            {appCard}
            {deploymentsCard}
            <details className="group">
              <summary className="text-muted-foreground cursor-pointer text-sm select-none">
                고급: GitHub Actions 워크플로로 배포하기
              </summary>
              <p className="text-muted-foreground mt-2 text-sm">
                빌드가 필요한 사이트처럼, 저장소의 파일을 그대로 올리지 않고
                워크플로에서 만든 결과를 배포할 때 씁니다.
              </p>
              <div className="mt-4">{workflowCard}</div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
