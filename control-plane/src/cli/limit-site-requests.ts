import { db } from "@/lib/database";
import { limitSiteRequests } from "@/lib/edge/site-requests";

// Counts hosted sites' requests and blocks those past their monthly
// allowance. See lib/edge/site-requests.ts.
async function main() {
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
