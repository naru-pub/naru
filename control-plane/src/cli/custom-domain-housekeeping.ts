import { db } from "@/lib/database";
import { runCustomDomainHousekeeping } from "@/lib/custom-domain-housekeeping";

// Tells owners of custom domains about to be released, and releases those
// whose notice has run out. See lib/custom-domain-housekeeping.ts.
async function main() {
  const { notices, withdrawn, released, purged } =
    await runCustomDomainHousekeeping();
  console.log(
    `[custom-domain-housekeeping] ${notices} notified, ${withdrawn} withdrawn, ` +
      `${released} released, ${purged} purged`,
  );
}

main().finally(() => db.destroy());
