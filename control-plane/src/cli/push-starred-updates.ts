import { pushStarredUpdates } from "@/lib/app-api/starred-updates";

// Pushes each account's starred sites' updates to the Naru app, once a day.
// See lib/app-api/starred-updates.ts.
async function main() {
  const { accounts, pushed } = await pushStarredUpdates();
  console.log(`[starred-updates] ${accounts} account(s), ${pushed} push(es)`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[starred-updates] fatal:", error);
    process.exit(1);
  });
