import { db } from "@/lib/database";
import { limitSiteRequests } from "@/lib/edge/site-requests";
import { applySuspensions } from "@/lib/site-moderation";

// Counts hosted sites' requests and blocks those past their monthly
// allowance (lib/edge/site-requests.ts), and keeps the rule blocking
// suspended sites current, retrying what /admin/moderation could not apply
// (lib/site-moderation.ts).
async function main() {
  await applySuspensions().catch((error) =>
    console.error("[site-request-limits] applying suspensions failed:", error),
  );
  const { counted, blocked } = await limitSiteRequests();
  console.log(
    counted
      ? `[site-request-limits] counted; ${blocked} host(s) blocked`
      : "[site-request-limits] Cloudflare is not configured; skipped",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
