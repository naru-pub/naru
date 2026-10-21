import { pushEdgeDomainsSoon } from "@/lib/edge/domains";
import { db } from "@/lib/database";
import {
  getCloudflareCustomHostname,
  toCustomDomainRow,
} from "@/lib/customDomains";

// Polls Cloudflare for the status of custom domains that aren't fully active
// yet, so verification completes without the user re-opening the account page
// and clicking 상태 확인. Active domains are skipped (they no longer match the
// predicate), and so are released ones, which have no Cloudflare hostname. A
// domain that never validates is released within weeks
// (lib/custom-domain-housekeeping.ts), which bounds the polling.

async function main() {
  const pending = await db
    .selectFrom("custom_domains")
    .select(["id", "hostname", "cloudflare_hostname_id"])
    .where("cloudflare_hostname_id", "is not", null)
    .$narrowType<{ cloudflare_hostname_id: string }>()
    .where((eb) =>
      eb.or([
        eb("verified_at", "is", null),
        eb("cloudflare_status", "!=", "active"),
        eb("ssl_status", "is", null),
        eb("ssl_status", "!=", "active"),
      ]),
    )
    .execute();

  console.log(`[refresh-custom-domains] ${pending.length} pending domain(s)`);
  let activated = false;

  for (const domain of pending) {
    try {
      const cloudflareHostname = await getCloudflareCustomHostname(
        domain.cloudflare_hostname_id,
      );
      const row = toCustomDomainRow(cloudflareHostname);

      await db
        .updateTable("custom_domains")
        .set(row)
        .where("id", "=", domain.id)
        .execute();
      if (row.verified_at) activated = true;

      console.log(
        `[refresh-custom-domains] ${domain.hostname}: host=${row.cloudflare_status} ssl=${row.ssl_status ?? "-"}${row.verified_at ? " (active)" : ""}`,
      );
    } catch (error) {
      console.error(
        `[refresh-custom-domains] ${domain.hostname} failed: ${error}`,
      );
    }
  }
  // A domain that became active is served at the edge at once.
  if (activated) await pushEdgeDomainsSoon();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[refresh-custom-domains] fatal:", error);
    process.exit(1);
  });
