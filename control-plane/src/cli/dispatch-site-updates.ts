import { parseArgs } from "node:util";
import { sql } from "kysely";
import { pushSender, type PushSender } from "@/lib/app-api/push";
import { db } from "@/lib/database";
import { dispatchSiteUpdate, siteUpdateCandidates } from "@/lib/site-updates";

// Usage:
//   pnpm exec tsx src/cli/dispatch-site-updates.ts
//     → scan all qualifying users (the cron path)
//   pnpm exec tsx src/cli/dispatch-site-updates.ts --user <login_name>
//     → dispatch for a single user, still gated by the three predicates
//   pnpm exec tsx src/cli/dispatch-site-updates.ts --user <login_name> --force
//     → reset the gate for that user so dispatchSiteUpdate is guaranteed to
//       fire. Use only for ops/testing.
//
// See lib/site-updates.ts.

async function dispatchForAll(sender: PushSender) {
  const candidates = await siteUpdateCandidates();

  console.log(`[dispatch-site-updates] ${candidates.length} candidate(s)`);

  for (const user of candidates) {
    try {
      await dispatchSiteUpdate(user.id, sender);
    } catch (err) {
      console.error(
        `[dispatch-site-updates] ${user.login_name} (id=${user.id}) failed:`,
        err
      );
    }
  }
}

async function dispatchForUser(
  loginName: string,
  force: boolean,
  sender: PushSender
) {
  const user = await db
    .selectFrom("users")
    .select(["id", "login_name", "site_updated_at", "last_activity_sent_at"])
    .where("login_name", "=", loginName)
    .executeTakeFirst();

  if (!user) {
    console.error(`[dispatch-site-updates] no such user: ${loginName}`);
    process.exitCode = 1;
    return;
  }

  if (force) {
    await db
      .updateTable("users")
      .set({
        last_activity_sent_at: null,
        site_updated_at: sql`now() - interval '11 minutes'`,
      })
      .where("id", "=", user.id)
      .execute();
    console.log(
      `[dispatch-site-updates] --force: reset gate for ${loginName}`
    );
  }

  const countBefore = await activityCount(user.id);
  const dispatched = await dispatchSiteUpdate(user.id, sender);
  const countAfter = await activityCount(user.id);

  if (dispatched) {
    console.log(
      `[dispatch-site-updates] ${loginName}: dispatched (${countBefore} → ${countAfter})`
    );
  } else {
    console.log(
      `[dispatch-site-updates] ${loginName}: skipped — predicates not met (edited in last 10min, cooldown not elapsed, or no new edits since last send)`
    );
  }
}

async function activityCount(userId: string): Promise<number> {
  const row = await db
    .selectFrom("activities")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("user_id", "=", userId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function main() {
  const { values } = parseArgs({
    options: {
      user: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });

  if (values.force && !values.user) {
    console.error("--force requires --user <login_name>");
    process.exitCode = 1;
    return;
  }

  const sender = pushSender();
  try {
    if (values.user) {
      await dispatchForUser(values.user, values.force ?? false, sender);
    } else {
      await dispatchForAll(sender);
    }
  } finally {
    sender.close();
  }

  await db.destroy();
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
