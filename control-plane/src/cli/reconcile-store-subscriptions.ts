import { db } from "@/lib/database";
import { appleApiConfigured } from "@/lib/payments/store/apple";
import {
  cancelPlaySubscription,
  playConfigured,
  voidedPlayOrders,
} from "@/lib/payments/store/google";
import { revokeStoreTransaction } from "@/lib/payments/store/ledger";
import { refreshStoreSubscription } from "@/lib/payments/store/sync";
import type { Store } from "@/lib/payments/store/products";

// Catches up on what the stores' notifications should have said
// (lib/payments/store): Play purchases still to acknowledge before Play
// refunds them, auto-renewal to switch off for deleted accounts, live
// subscriptions whose period ended without word of a renewal or lapse, and
// Play orders refunded since the last few days.

const BATCH_SIZE = 100;
const STALE_MS = 60 * 60 * 1000;
const VOIDED_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

type Row = {
  store: Store;
  store_key: string;
  environment: "sandbox" | "production";
  product_id: string;
};
const COLUMNS = ["store", "store_key", "environment", "product_id"] as const;

async function main() {
  const now = new Date();
  const stores: Store[] = [];
  if (appleApiConfigured()) stores.push("apple");
  if (playConfigured()) stores.push("google");
  if (!stores.length) {
    console.log("[reconcile-store-subscriptions] no store configured");
    return;
  }
  const google = stores.includes("google");

  const due = new Map<string, Row>();
  const unacknowledged = google
    ? await db
        .selectFrom("store_subscriptions")
        .select(COLUMNS)
        .where("store", "=", "google")
        .where("acknowledged_at", "is", null)
        .where("status", "in", ["active", "billing_retry"])
        .limit(BATCH_SIZE)
        .execute()
    : [];
  const stale = await db
    .selectFrom("store_subscriptions")
    .select(COLUMNS)
    .where("store", "in", stores)
    .where("status", "in", ["active", "billing_retry"])
    .where("expires_at", "<", now)
    .where("synced_at", "<", new Date(now.getTime() - STALE_MS))
    .orderBy("synced_at")
    .limit(BATCH_SIZE)
    .execute();
  for (const row of [...unacknowledged, ...stale])
    due.set(`${row.store}:${row.store_key}`, row);

  let failed = 0;
  for (const row of due.values()) {
    try {
      const applied = await refreshStoreSubscription(row);
      console.log(
        `[reconcile-store-subscriptions] ${row.store} ${row.product_id}: ${applied ? (applied.applied ? "refreshed" : "unbound") : "not found"}`,
      );
    } catch (error) {
      failed++;
      console.error(
        `[reconcile-store-subscriptions] ${row.store} refresh failed`,
        error,
      );
    }
  }

  if (google) {
    const canceling = await db
      .selectFrom("store_subscriptions")
      .select(COLUMNS)
      .where("store", "=", "google")
      .where("cancel_requested_at", "is not", null)
      .where("auto_renews", "=", true)
      .where("status", "in", ["active", "billing_retry"])
      .limit(BATCH_SIZE)
      .execute();
    for (const row of canceling) {
      try {
        await cancelPlaySubscription(row.product_id, row.store_key);
        await refreshStoreSubscription(row);
        console.log("[reconcile-store-subscriptions] canceled a Play renewal");
      } catch (error) {
        failed++;
        console.error("[reconcile-store-subscriptions] cancel failed", error);
      }
    }
    try {
      const voided = await voidedPlayOrders(
        new Date(now.getTime() - VOIDED_WINDOW_MS),
      );
      for (const order of voided)
        if (
          await revokeStoreTransaction("google", order.orderId, order.voidedAt)
        )
          console.log(
            `[reconcile-store-subscriptions] revoked voided order ${order.orderId}`,
          );
    } catch (error) {
      failed++;
      console.error("[reconcile-store-subscriptions] voided purchases", error);
    }
  }
  if (failed) throw new Error(`${failed} store operation(s) failed`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[reconcile-store-subscriptions] fatal:", error);
    process.exit(1);
  });
