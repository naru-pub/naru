import { db } from "@/lib/database";
import { deleteCloudflareCustomHostnameIfExists } from "@/lib/customDomains";
import { accessEndsAtOf } from "@/lib/entitlements";

const ABANDONED_PENDING_DOMAIN_DAYS = 14;

type DomainToDelete = {
  id: string;
  hostname: string;
  cloudflare_hostname_id: string;
  user_id: string;
};

async function deleteDomain(domain: DomainToDelete, reason: string) {
  try {
    await deleteCloudflareCustomHostnameIfExists(domain.cloudflare_hostname_id);
  } catch (error) {
    console.error(
      `[cleanup-expired-custom-domains] ${domain.hostname}: Cloudflare delete failed:`,
      error,
    );
    return;
  }

  await db.deleteFrom("custom_domains").where("id", "=", domain.id).execute();

  console.log(
    `[cleanup-expired-custom-domains] ${domain.hostname}: removed for user ${domain.user_id} (${reason})`,
  );
}

async function main() {
  const now = new Date();

  const expiredDomains = await db
    .selectFrom("custom_domains")
    .innerJoin("users", "users.id", "custom_domains.user_id")
    .leftJoin("supporter_trials", "supporter_trials.user_id", "users.id")
    .select([
      "custom_domains.id",
      "custom_domains.hostname",
      "custom_domains.cloudflare_hostname_id",
      "custom_domains.user_id",
      "users.supporter_comp",
      "users.supporter_until",
      "supporter_trials.ends_at as trial_ends_at",
    ])
    .where("users.supporter_comp", "=", false)
    .execute();

  // Past paid access, its payment grace and any free trial.
  const reclaimableDomains = expiredDomains.filter(
    (domain) => (accessEndsAtOf(domain) ?? Infinity) <= now.getTime(),
  );

  console.log(
    `[cleanup-expired-custom-domains] ${reclaimableDomains.length} expired domain(s) outside paid access/payment grace/trial`,
  );

  for (const domain of reclaimableDomains) {
    await deleteDomain(domain, "supporter access expired");
  }

  const abandonedCutoff = new Date(
    now.getTime() - ABANDONED_PENDING_DOMAIN_DAYS * 24 * 60 * 60 * 1000,
  );
  const abandonedPendingDomains = await db
    .selectFrom("custom_domains")
    .select(["id", "hostname", "cloudflare_hostname_id", "user_id"])
    .where("created_at", "<=", abandonedCutoff)
    .where((eb) =>
      eb.or([
        eb("verified_at", "is", null),
        eb("cloudflare_status", "!=", "active"),
        eb("ssl_status", "is", null),
        eb("ssl_status", "!=", "active"),
      ]),
    )
    .execute();

  console.log(
    `[cleanup-expired-custom-domains] ${abandonedPendingDomains.length} abandoned pending domain(s) older than ${ABANDONED_PENDING_DOMAIN_DAYS} days`,
  );

  for (const domain of abandonedPendingDomains) {
    await deleteDomain(domain, "abandoned pending verification");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[cleanup-expired-custom-domains] fatal:", error);
    process.exit(1);
  });
