import { db } from "@/lib/database";
import { runPendingDeploys } from "@/lib/deploy/githubAppDeploy";

// Deploys the repositories GitHub reported pushes to (lib/deploy/
// githubAppDeploy.ts). The webhook starts them at once; this catches what it
// did not finish, such as a deploy cut off by a release.
async function main() {
  const deployed = await runPendingDeploys({ limit: 50 });
  if (deployed) console.log(`[github-app] Deployed ${deployed} target(s)`);
}

main().finally(() => db.destroy());
