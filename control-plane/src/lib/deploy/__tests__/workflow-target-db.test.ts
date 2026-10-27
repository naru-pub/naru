/** @jest-environment node */
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { sql } from "kysely";

import { db } from "@/lib/database";
import {
  planDeployment,
  publishPlannedDeployment,
  updateGitHubDeployTarget,
  upsertGitHubDeployTarget,
} from "../siteDeploy";

// Editing a GitHub Actions deploy target, against the disposable database of
// scripts/test-payments-db.sh.
const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

integration("editing a workflow deploy target", () => {
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    const insert = async (name: string) =>
      (
        await sql<{
          id: string;
        }>`insert into users (login_name, password_hash, supporter_comp)
          values (${name}, 'x', true) returning id`.execute(db)
      ).rows[0].id;
    userId = await insert("workflow-editor");
    otherUserId = await insert("workflow-bystander");
  });
  afterAll(async () => {
    await sql`delete from github_deploy_targets
      where user_id in (${userId}, ${otherUserId})`.execute(db);
    await sql`delete from users where id in (${userId}, ${otherUserId})`.execute(
      db,
    );
    await db.destroy();
  });

  const add = (prefix: string, user = userId) =>
    upsertGitHubDeployTarget({
      user: { id: user },
      githubRepository: "owner/site",
      githubRef: "refs/heads/main",
      targetPrefix: prefix,
    });
  const find = (prefix: string, user = userId) =>
    db
      .selectFrom("github_deploy_targets")
      .selectAll()
      .where("user_id", "=", user)
      .where("target_prefix", "=", prefix)
      .executeTakeFirstOrThrow();
  const plan = (target: Awaited<ReturnType<typeof find>>) =>
    planDeployment({
      target,
      manifest: {
        files: [{ path: "index.html", sha256: "a".repeat(64), size: 1 }],
      },
      repository: target.github_repository,
      repositoryId: "1001",
      ref: target.github_ref,
      sha: "sha-1",
    });

  test("keeps the target and its deployments, and stops what was planned before", async () => {
    await add("blog");
    const before = await find("blog");
    const planned = await plan(before);
    await db
      .updateTable("github_deploy_targets")
      .set({ last_manifest: sql`'{"files":[]}'::jsonb` })
      .where("id", "=", before.id)
      .execute();

    await updateGitHubDeployTarget({
      user: { id: userId },
      id: before.id,
      githubRepository: "owner/other",
      githubRef: "refs/tags/v1",
      targetPrefix: "/notes/",
    });

    const after = await find("notes");
    expect(after).toMatchObject({
      id: before.id,
      github_repository: "owner/other",
      github_ref: "refs/tags/v1",
      enabled: true,
      // A new repository is bound on its first deploy; a new folder has no
      // published files yet.
      github_repository_id: null,
      last_manifest: null,
    });
    expect(after.deploy_generation).toBeGreaterThan(before.deploy_generation + 1);
    await expect(publishPlannedDeployment(planned.id)).rejects.toThrow(
      "A newer deployment has already updated this target",
    );
  });

  test("folds a deleted target saved under the new settings into the edited one", async () => {
    await add("old");
    const deleted = await find("old");
    const planned = await plan(deleted);
    await db
      .updateTable("github_deploy_targets")
      .set({ enabled: false })
      .where("id", "=", deleted.id)
      .execute();
    await add("new");
    const edited = await find("new");

    await updateGitHubDeployTarget({
      user: { id: userId },
      id: edited.id,
      githubRepository: "owner/site",
      githubRef: "refs/heads/main",
      targetPrefix: "old",
    });

    expect(await find("old")).toMatchObject({ id: edited.id, enabled: true });
    expect(
      await db
        .selectFrom("github_deployments")
        .select("target_id")
        .where("id", "=", planned.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ target_id: edited.id });
    await expect(publishPlannedDeployment(planned.id)).rejects.toThrow(
      "A newer deployment has already updated this target",
    );
  });

  test("refuses overlapping folders and other accounts' targets", async () => {
    await add("docs");
    const docs = await find("docs");
    const edit = (prefix: string, user = userId) =>
      updateGitHubDeployTarget({
        user: { id: user },
        id: docs.id,
        githubRepository: "owner/site",
        githubRef: "refs/heads/main",
        targetPrefix: prefix,
      });

    await expect(edit("old/inner")).rejects.toThrow("겹칩니다");
    await expect(edit("/")).rejects.toThrow("겹칩니다");
    await expect(edit("guide", otherUserId)).rejects.toThrow(
      "GitHub deploy target was not found",
    );
    // Unchanged settings are no edit at all.
    await edit("docs");
    expect(await find("docs")).toMatchObject({
      deploy_generation: docs.deploy_generation,
    });
  });
});
