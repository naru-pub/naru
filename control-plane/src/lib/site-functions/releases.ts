import { sql } from "kysely";
import { db } from "@/lib/database";
import { callSiteObject } from "@/lib/edge/client";
import { MAINTENANCE_QUEUE } from "@/lib/maintenance/jobs";
import { uuidv7 } from "@/lib/uuid";
import { DataError } from "@/lib/site-data/validation";
import { FunctionRevisions, routesKey } from "./revisions";
import { revisionStorage, deleteRevision } from "./storage";
import type { TaskContext } from "absurd-sdk";

export const FUNCTION_RELEASE_TASK = "function-release-v1";
export const FUNCTION_RELEASE_GRACE_SECONDS = 300;
export type FunctionRelease = {
  site: string;
  revision: string;
  generation: string;
  retired: { id: string; revision: string } | null;
};

/**
 * Publishing owns the snapshot and atomically records its eventual retirement
 * work. It activates the release before it returns, unless a workflow
 * deployment publishes it (`deploymentId`): its finalize must not wait, since
 * Cloudflare cuts the request off at 100 seconds, so only the durable task
 * activates it and records how that went on the deployment.
 */
export async function publishSiteFunctions(
  site: string,
  options: { deploymentId?: string } = {},
): Promise<{ revision: string; generation: string }> {
  const release = await db.transaction().execute(async (tx) => {
    // Serialize publications for this owner, including snapshot reads and the task outbox.
    const user = await tx
      .selectFrom("users")
      .select("id")
      .where("login_name", "=", site)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const previous = await tx
      .selectFrom("site_function_releases")
      .select(["id", "revision"])
      .where("user_id", "=", user.id)
      .orderBy("id", "desc")
      .executeTakeFirst();
    const revision = await new FunctionRevisions(
      revisionStorage,
      site,
    ).publish();
    const generation = uuidv7(
      previous
        ? Math.max(
            Date.now(),
            parseInt(previous.id.replaceAll("-", "").slice(0, 12), 16) + 1,
          )
        : Date.now(),
    );
    const release: FunctionRelease = {
      site,
      revision,
      generation,
      retired: previous ?? null,
    };
    await tx
      .insertInto("site_function_releases")
      .values({ id: generation, user_id: user.id, revision })
      .execute();
    // Before the task exists, so its outcome always finds the deployment.
    if (options.deploymentId)
      await tx
        .updateTable("github_deployments")
        .set({
          functions_release_id: generation,
          functions_status: "activating",
        })
        .where("id", "=", options.deploymentId)
        .execute();
    // Unlimited retries: temporary edge/R2 outages must not abandon release activation or cleanup.
    await sql`select absurd.spawn_task(${MAINTENANCE_QUEUE}, ${FUNCTION_RELEASE_TASK}, ${JSON.stringify(release)}::jsonb,
      ${JSON.stringify({ idempotency_key: `function-release:${generation}`, retry_strategy: { kind: "exponential", base_seconds: 60, factor: 2, max_seconds: 600 } })}::jsonb)`.execute(
      tx,
    );
    return release;
  });
  // The durable task repeats this after a crash or a failed response.
  if (!options.deploymentId) await activateRelease(release);
  return { revision: release.revision, generation: release.generation };
}

export async function activateRelease(release: FunctionRelease) {
  const owner = await db
    .selectFrom("site_function_releases as release")
    .innerJoin("users", "users.id", "release.user_id")
    .select("release.id")
    .where("release.id", "=", release.generation)
    .where("release.revision", "=", release.revision)
    .where("users.login_name", "=", release.site)
    .where("users.deleted_at", "is", null)
    .executeTakeFirst();
  // A cleaned release or deleted account must not be reactivated by a late task.
  if (!owner) return null;
  const revisions = new FunctionRevisions(revisionStorage, release.site);
  const active = await callSiteObject<{ revision: string }>(
    release.site,
    "activateFunctions",
    {
      revision: release.revision,
      generation: release.generation,
      // Its SQL migrations (1.1.0), which the object applies on activation.
      site: release.site,
      migrations: await revisions.migrations(release.revision),
    },
  );
  // The paths the active release routes, for the edge Worker (routes.ts),
  // whichever release that is.
  await revisionStorage.put(
    routesKey(release.site),
    JSON.stringify({
      revision: active.revision,
      ...(await revisions.routes(active.revision)),
    }),
  );
  return active;
}

/**
 * Whether the site refused the release for good: a migration that failed or
 * changed one already applied (422). Retrying would fail the same way.
 */
export const refused = (error: unknown) =>
  error instanceof DataError && error.status === 422;

/** How a workflow deploy's deferred release went, for the workflow to ask. */
function recordDeployedRelease(
  release: FunctionRelease,
  outcome: {
    functions_status: "active" | "refused";
    functions_error?: string;
  },
) {
  return db
    .updateTable("github_deployments")
    .set(outcome)
    .where("functions_release_id", "=", release.generation)
    .execute();
}

/** Absurd owns waiting, R2 deletion, and retries; no edge cleanup calls are made. */
export async function runFunctionRelease(
  release: FunctionRelease,
  ctx: Pick<TaskContext, "step" | "sleepFor" | "heartbeat">,
) {
  const activated = await ctx.step("activate", async () => {
    try {
      await activateRelease(release);
      await recordDeployedRelease(release, { functions_status: "active" });
      return true;
    } catch (error) {
      if (!refused(error)) throw error;
      const { message, details } = error as DataError;
      await recordDeployedRelease(release, {
        functions_status: "refused",
        functions_error: JSON.stringify({ message, details }),
      });
      return false;
    }
  });
  // A refused release never ran: its files go, and the one before it, still
  // active, stays.
  if (!activated) {
    await ctx.step("discard-refused-revision", async () => {
      await deleteRevision(release.site, release.revision, () =>
        ctx.heartbeat(),
      );
      await db
        .deleteFrom("site_function_releases")
        .where("id", "=", release.generation)
        .where("revision", "=", release.revision)
        .execute();
      return null;
    });
    return;
  }
  if (!release.retired) return;
  await ctx.sleepFor("retirement-grace", FUNCTION_RELEASE_GRACE_SECONDS);
  await ctx.step("delete-retired-revision", async () => {
    await deleteRevision(release.site, release.retired!.revision, () =>
      ctx.heartbeat(),
    );
    await db
      .deleteFrom("site_function_releases")
      .where("id", "=", release.retired!.id)
      .where("revision", "=", release.retired!.revision)
      .execute();
    return null;
  });
}
