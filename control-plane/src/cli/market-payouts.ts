import "@/lib/payments/toss-calls";
import { db } from "@/lib/database";
import { runMarketMaintenance } from "@/lib/market/market-jobs";

// Daily through Absurd: the template marketplace's upkeep and payouts
// (lib/market/market-jobs). Toss is called by the payment worker's tasks,
// not here.
runMarketMaintenance()
  .then(({ stale, payouts }) => {
    console.log(
      `[market-payouts] ${stale} pending order(s) to reconcile, ${payouts} payout(s) queued`,
    );
  })
  .catch((error) => {
    console.error("[market-payouts] fatal:", error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
