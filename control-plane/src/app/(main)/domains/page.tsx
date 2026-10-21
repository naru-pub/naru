import { redirect } from "next/navigation";

import { validateRequest } from "@/lib/auth";
import { getCustomDomainTarget } from "@/lib/customDomains";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import {
  housekeepingRows,
  releaseSchedule,
} from "@/lib/custom-domain-housekeeping";
import CustomDomainsCard from "../account/CustomDomainsCard";

export default async function DomainsPage() {
  const { user } = await validateRequest();

  if (!user) {
    redirect("/");
  }

  if (!(await userHasFeature(user.id, "custom_domains"))) {
    redirect("/account");
  }

  const customDomainRows = await db
    .selectFrom("custom_domains")
    .select([
      "id",
      "hostname",
      "cloudflare_status",
      "ssl_status",
      "ownership_verification_name",
      "ownership_verification_type",
      "ownership_verification_value",
      "ssl_validation_records",
      "verification_errors",
      "verified_at",
      "released_at",
      "release_reason",
    ])
    .where("user_id", "=", user.id)
    .orderBy("id", "desc")
    .execute();
  // When a domain the owner was told about will be released.
  const schedules = new Map(
    (await housekeepingRows(user.id)).map((row) => [
      row.id,
      releaseSchedule(row),
    ]),
  );
  const customDomains = customDomainRows.map((domain) => {
    const releaseAt = schedules.get(domain.id)?.releaseAt ?? null;
    return {
      id: domain.id,
      hostname: domain.hostname,
      cloudflareStatus: domain.cloudflare_status,
      sslStatus: domain.ssl_status,
      ownershipVerificationName: domain.ownership_verification_name,
      ownershipVerificationType: domain.ownership_verification_type,
      ownershipVerificationValue: domain.ownership_verification_value,
      sslValidationRecords: domain.ssl_validation_records,
      verificationErrors: domain.verification_errors,
      verifiedAt: domain.verified_at?.toISOString() ?? null,
      releasedAt: domain.released_at?.toISOString() ?? null,
      releaseReason: domain.release_reason,
      releaseAt: releaseAt?.toISOString() ?? null,
      releaseAtReason: releaseAt ? schedules.get(domain.id)!.reason : null,
    };
  });

  return (
    <div className="bg-background min-h-screen">
      <div className="mx-auto max-w-4xl space-y-8 p-6">
        <CustomDomainsCard
          enabled
          domains={customDomains}
          target={getCustomDomainTarget()}
        />
      </div>
    </div>
  );
}
