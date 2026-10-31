import { randomUUID } from "crypto";
import { db } from "@/lib/database";
import { enqueueJob, type PaymentJob } from "@/lib/payments/payment-jobs";
import { notePaymentEvent, won } from "@/lib/payments/payment-events";
import {
  cancelOrder,
  confirmOrder,
  lookupOrder,
} from "@/lib/payments/toss-gateway";
import {
  configuredMid,
  describeTossError,
  type TossPaymentResult,
} from "@/lib/payments/toss";
import {
  cancelOpenPayout,
  createDuePayouts,
  openPayoutIds,
  sendPayout,
  syncPayout,
  unsentPayoutIds,
} from "./payouts";
import { syncSeller } from "./sellers";
import { UNCONFIRMED_ORDER_MS } from "./purchases";

// The marketplace's Absurd tasks, run by the payment worker
// (lib/payments/payment-jobs hands them here). Every one is safe to run
// again: each reads the row and Toss before it writes, and writes only from
// the state it found.

export type MarketJob = Extract<
  PaymentJob,
  {
    kind:
      | "confirm_template_purchase"
      | "refund_template_purchase"
      | "reconcile_template_purchase"
      | "request_payout"
      | "sync_payout"
      | "sync_seller";
  }
>;

export async function handleMarketJob(job: MarketJob): Promise<void> {
  switch (job.kind) {
    case "confirm_template_purchase":
      return confirmPurchase(job.purchaseId);
    case "refund_template_purchase":
      return refundPurchase(job.purchaseId);
    case "reconcile_template_purchase":
      return reconcilePurchase(job.purchaseId);
    case "request_payout":
      return sendPayout(job.payoutId);
    case "sync_payout":
      return syncPayout(job.payoutId);
    case "sync_seller":
      await syncSeller(job.tossSellerId);
      return;
  }
}

async function loadPurchase(purchaseId: string) {
  return db
    .selectFrom("template_purchases")
    .selectAll()
    .where("id", "=", purchaseId)
    .executeTakeFirstOrThrow();
}

// Toss's record of the order must be this order, at 나루's amount, on the
// market MID, before anything is written from it.
function matches(
  purchase: { order_id: string; amount: number; toss_mid: string | null },
  payment: TossPaymentResult,
): boolean {
  const mid = purchase.toss_mid ?? configuredMid("market");
  return (
    payment.orderId === purchase.order_id &&
    payment.totalAmount === purchase.amount &&
    (mid == null || payment.mId == null || payment.mId === mid)
  );
}

// Writes what Toss says became of a pending order.
async function settle(purchaseId: string, payment: TossPaymentResult) {
  const purchase = await loadPurchase(purchaseId);
  if (!matches(purchase, payment)) {
    throw new Error(
      `Toss's order ${payment.orderId} does not match purchase ${purchase.id}`,
    );
  }
  const provider = {
    toss_payment_key: payment.paymentKey,
    toss_mid: payment.mId ?? null,
    toss_method: payment.method ?? null,
    toss_receipt_url: payment.receipt?.url ?? null,
    raw: JSON.stringify(payment),
  };
  switch (payment.status) {
    case "DONE":
      try {
        await db
          .updateTable("template_purchases")
          .set({
            ...provider,
            status: "done",
            paid_at: payment.approvedAt
              ? new Date(payment.approvedAt)
              : new Date(),
          })
          .where("id", "=", purchaseId)
          .where("status", "=", "pending")
          .execute();
      } catch (error) {
        if (!isSecondPurchase(error)) throw error;
        return refundSecondPurchase(purchaseId, payment);
      }
      return;
    case "CANCELED":
    case "PARTIAL_CANCELED":
      // A refund: from 나루, or the Toss dashboard. A sale already in a
      // payout takes that payout back while Toss still can; past that the
      // operators settle with the seller, and the ledger keeps it.
      if (purchase.status === "done" && purchase.payout_id) {
        if (!(await cancelOpenPayout(purchase.payout_id))) {
          await notePaymentEvent({
            kind: "template_refund_after_payout",
            summary: `판매자 정산에 들어간 템플릿 구매 ${purchase.order_id}(${won(purchase.amount)})가 Toss에서 환불됨: 정산을 되돌리지 못해 판매자와 따로 정산해야 함`,
          });
        }
      }
      await db
        .updateTable("template_purchases")
        .set({ ...provider, status: "canceled", canceled_at: new Date() })
        .where("id", "=", purchaseId)
        .where("status", "in", ["pending", "done"])
        .execute();
      return;
    case "ABORTED":
    case "EXPIRED":
      await db
        .updateTable("template_purchases")
        .set({ ...provider, status: "expired" })
        .where("id", "=", purchaseId)
        .where("status", "=", "pending")
        .execute();
      return;
    default:
      // READY, IN_PROGRESS, WAITING_FOR_DEPOSIT: not decided yet.
      throw new Error(
        `Purchase ${purchaseId} is still ${payment.status} at Toss`,
      );
  }
}

// template_purchases_one_done_idx: the buyer has this template already.
function isSecondPurchase(error: unknown): boolean {
  const { code, constraint } = (error ?? {}) as {
    code?: string;
    constraint?: string;
  };
  return code === "23505" && constraint === "template_purchases_one_done_idx";
}

// Two tabs' orders approved at once: the one that found the template
// already bought is charged back.
async function refundSecondPurchase(
  purchaseId: string,
  payment: TossPaymentResult,
): Promise<void> {
  const outcome = await cancelOrder({
    flow: "market",
    paymentKey: payment.paymentKey,
    cancelReason: "이미 산 템플릿의 중복 결제",
  });
  if (outcome.kind === "canceled") return settle(purchaseId, outcome.payment);
  const found = await lookupOrder(payment.orderId, "market");
  if (found.kind === "found" && found.payment.status !== "DONE") {
    return settle(purchaseId, found.payment);
  }
  throw new Error(
    `Second purchase ${purchaseId} is charged and not yet refunded: ${describeTossError(outcome.error)}`,
  );
}

async function confirmPurchase(purchaseId: string): Promise<void> {
  const purchase = await loadPurchase(purchaseId);
  if (purchase.status !== "pending") return;
  if (!purchase.toss_payment_key)
    throw new Error(`Purchase ${purchaseId} has no payment key`);
  // An approval that may have gone through before its answer was written.
  if (purchase.charge_attempted_at) {
    const found = await lookupOrder(purchase.order_id, "market");
    if (found.kind === "unknown") throw found.error;
    if (found.kind === "found" && found.payment.status !== "IN_PROGRESS") {
      await settle(purchaseId, found.payment);
      return;
    }
  }
  // Bought meanwhile in another tab, or gone with its author's account:
  // not approving lets Toss expire the authentication without charging the
  // card. Two tabs approved at once are caught in settle.
  const owned =
    purchase.template_id === null ||
    (await db
      .selectFrom("template_purchases")
      .select("id")
      .where("template_id", "=", purchase.template_id)
      .where("buyer_id", "=", purchase.buyer_id)
      .where("status", "=", "done")
      .executeTakeFirst());
  if (owned) {
    if (purchase.charge_attempted_at)
      throw new Error(`Superseded purchase ${purchaseId} is unresolved`);
    await db
      .updateTable("template_purchases")
      .set({ status: "expired" })
      .where("id", "=", purchaseId)
      .where("status", "=", "pending")
      .execute();
    return;
  }
  const outcome = await confirmOrder({
    flow: "market",
    paymentKey: purchase.toss_payment_key,
    orderId: purchase.order_id,
    amount: purchase.amount,
    firstKey: purchase.charge_attempted_at
      ? `${purchase.order_id}:${randomUUID()}`
      : purchase.order_id,
    retryOnce: true,
    beforeSend: async () => {
      await db
        .updateTable("template_purchases")
        .set({ charge_attempted_at: new Date() })
        .where("id", "=", purchaseId)
        .execute();
    },
  });
  if (outcome.kind === "approved") return settle(purchaseId, outcome.payment);
  if (outcome.kind === "declined") {
    if (outcome.payment) return settle(purchaseId, outcome.payment);
    await db
      .updateTable("template_purchases")
      .set({
        status: "failed",
        raw: JSON.stringify({ error: describeTossError(outcome.error) }),
      })
      .where("id", "=", purchaseId)
      .where("status", "=", "pending")
      .execute();
    return;
  }
  throw new Error(
    `Purchase ${purchaseId} approval is unknown: ${describeTossError(outcome.error)}`,
  );
}

async function refundPurchase(purchaseId: string): Promise<void> {
  const purchase = await loadPurchase(purchaseId);
  if (purchase.status !== "done" || !purchase.refund_requested_at) return;
  if (purchase.payout_id)
    throw new Error(`Purchase ${purchaseId} was paid out before its refund`);
  const outcome = await cancelOrder({
    flow: "market",
    paymentKey: purchase.toss_payment_key!,
    cancelReason: "구매자 환불 요청",
  });
  if (outcome.kind === "canceled") return settle(purchaseId, outcome.payment);
  // Refused (already canceled, say) or unknown: Toss's record decides.
  const found = await lookupOrder(purchase.order_id, "market");
  if (found.kind === "found" && found.payment.status !== "DONE") {
    return settle(purchaseId, found.payment);
  }
  if (outcome.kind === "refused" && found.kind === "found") {
    // Toss will not cancel it: back to an ordinary sale, paid out as one.
    await db
      .updateTable("template_purchases")
      .set({ refund_requested_at: null })
      .where("id", "=", purchaseId)
      .execute();
    console.error(
      `[market] refund of purchase ${purchaseId} refused: ${describeTossError(outcome.error)}`,
    );
    return;
  }
  throw new Error(
    `Refund of purchase ${purchaseId} is unresolved: ${describeTossError(outcome.error)}`,
  );
}

// From a payment webhook, and for orders left pending: Toss's record decides.
async function reconcilePurchase(purchaseId: string): Promise<void> {
  const purchase = await loadPurchase(purchaseId);
  if (purchase.status !== "pending" && purchase.status !== "done") return;
  const found = await lookupOrder(purchase.order_id, "market");
  if (found.kind === "unknown") throw found.error;
  if (found.kind === "not_found") {
    // Toss never saw it: a payment window closed without paying.
    if (
      purchase.status === "pending" &&
      !purchase.toss_payment_key &&
      Date.now() - new Date(purchase.created_at).getTime() >
        UNCONFIRMED_ORDER_MS
    ) {
      await db
        .updateTable("template_purchases")
        .set({ status: "expired" })
        .where("id", "=", purchaseId)
        .where("status", "=", "pending")
        .execute();
    }
    return;
  }
  if (found.payment.status === "DONE" && purchase.status === "done") return;
  if (
    ["READY", "IN_PROGRESS", "WAITING_FOR_DEPOSIT"].includes(
      found.payment.status,
    )
  )
    return;
  await settle(purchaseId, found.payment);
}

/**
 * The daily market run (cli/market-payouts): orders left pending, payouts
 * whose task gave up before Toss took them, payouts Toss may have finished
 * without telling, then new payouts.
 */
export async function runMarketMaintenance(now = new Date()) {
  const stale = await db
    .selectFrom("template_purchases")
    .select("id")
    .where("status", "=", "pending")
    .where("created_at", "<", new Date(now.getTime() - UNCONFIRMED_ORDER_MS))
    .execute();
  for (const purchase of stale) {
    await enqueueJob(
      db,
      { kind: "reconcile_template_purchase", purchaseId: purchase.id },
      {
        dedupeKey: `template-purchase-reconcile:${purchase.id}:${now.toISOString().slice(0, 10)}`,
      },
    );
  }
  for (const payoutId of await unsentPayoutIds(now)) {
    await enqueueJob(
      db,
      { kind: "request_payout", payoutId },
      {
        dedupeKey: `payout-request:${payoutId}:${now.toISOString().slice(0, 10)}`,
      },
    );
  }
  for (const payoutId of await openPayoutIds()) {
    await enqueueJob(
      db,
      { kind: "sync_payout", payoutId },
      {
        dedupeKey: `payout-sync:${payoutId}:${now.toISOString().slice(0, 10)}`,
      },
    );
  }
  const payouts = await createDuePayouts(now);
  return { stale: stale.length, payouts };
}
