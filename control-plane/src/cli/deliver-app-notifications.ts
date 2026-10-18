import { deliverAppNotifications } from "@/lib/app-api/delivery";

// Delivers what sites queued with ctx.notify to the Naru app: the accounts'
// inboxes, and pushes to their devices. See lib/app-api/delivery.ts.
async function main() {
  const { sites, stored, pushed } = await deliverAppNotifications();
  if (stored)
    console.log(
      `[app-notifications] ${stored} notification(s) from ${sites} site(s), ${pushed} push(es)`,
    );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[app-notifications] fatal:", error);
    process.exit(1);
  });
