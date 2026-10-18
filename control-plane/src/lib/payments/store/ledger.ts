import { db } from "@/lib/database";
import type { Executor } from "@/lib/entitlements";
import { recordPaymentEvent } from "@/lib/payments/payment-events";
import {
  extendPaidTime,
  lockPaidTime,
  recomputePaidTime,
} from "@/lib/payments/paid-time";
import { parseUuid } from "@/lib/uuid";
import { STORE_LABELS, type Store } from "./products";

// What a store reported about one subscription, verified (lib/payments/store/
// apple, google). Applied the same way whether the app sent it, a store
// notification did, or reconciliation asked for it: the stores are the
// authority on what was charged and refunded, and 나루 keeps a copy.
export type StoreState = {
  store: Store;
  // App Store originalTransactionId; Play purchase token.
  storeKey: string;
  productId: string;
  environment: "sandbox" | "production";
  // The account the app bound the purchase to (appAccountToken,
  // obfuscatedExternalAccountId), when it did.
  accountToken: string | null;
  status: "active" | "billing_retry" | "expired" | "revoked";
  expiresAt: Date;
  // Unknown when the store did not say (a device transaction without its
  // renewal info): the stored value stays.
  autoRenews: boolean | null;
  acknowledged?: boolean;
  // A Play purchase this one replaced (an upgrade, a resubscription).
  replacesKey?: string | null;
  // The periods it charged for that this report covers, each once.
  transactions: Array<{
    id: string;
    purchasedAt: Date | null;
    periodEnd: Date;
    revokedAt: Date | null;
    priceMicros?: number | null;
    currency?: string | null;
  }>;
};

// A purchase the store's signature or records do not vouch for.
export class StoreVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreVerificationError";
  }
}

export class StoreOwnershipError extends Error {
  constructor() {
    super("다른 나루 계정에 연결된 구독입니다. 그 계정으로 로그인해 주세요.");
    this.name = "StoreOwnershipError";
  }
}

export type AppliedStoreState =
  | { applied: true; userId: string; subscriptionId: string }
  // No account to give it to: a notification for a purchase the app never
  // bound or sent. Kept in store_notifications; the app's restore sends it.
  | { applied: false; reason: "unbound" };

// Records a verified store report and moves paid time with it. `claimedBy`
// is the signed-in account when the app sent it: a purchase is that account's
// only if the store bound it there (or nowhere) and no other account holds it
// already. A subscription never moves between accounts.
export async function applyStoreState(
  state: StoreState,
  opts: { claimedBy?: string } = {},
): Promise<AppliedStoreState> {
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom("store_subscriptions")
      .select(["id", "user_id", "auto_renews", "status"])
      .where("store", "=", state.store)
      .where("store_key", "=", state.storeKey)
      .executeTakeFirst();
    const bound = parseUuid(state.accountToken);
    if (opts.claimedBy) {
      if (bound && bound !== opts.claimedBy) throw new StoreOwnershipError();
      if (existing && existing.user_id !== opts.claimedBy)
        throw new StoreOwnershipError();
    }
    const owner =
      existing?.user_id ??
      opts.claimedBy ??
      (bound ? await accountFor(trx, bound) : null);
    if (!owner) return { applied: false, reason: "unbound" };

    // Grants and refunds lock the account's paid time first (paid-time.ts).
    await lockPaidTime(trx, owner);
    const now = new Date();
    const autoRenews = state.autoRenews ?? existing?.auto_renews ?? true;
    // Revoked stays revoked: a later report of an older state cannot undo it.
    const status = existing?.status === "revoked" ? "revoked" : state.status;
    const subscription = await trx
      .insertInto("store_subscriptions")
      .values({
        user_id: owner,
        store: state.store,
        store_key: state.storeKey,
        product_id: state.productId,
        environment: state.environment,
        status,
        expires_at: state.expiresAt,
        auto_renews: autoRenews,
        acknowledged_at: state.acknowledged ? now : null,
        synced_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["store", "store_key"]).doUpdateSet((eb) => ({
          product_id: eb.ref("excluded.product_id"),
          status: eb.ref("excluded.status"),
          expires_at: eb.ref("excluded.expires_at"),
          auto_renews: eb.ref("excluded.auto_renews"),
          acknowledged_at: eb.fn.coalesce(
            "store_subscriptions.acknowledged_at",
            "excluded.acknowledged_at",
          ),
          synced_at: now,
          updated_at: now,
        })),
      )
      .returning(["id", "user_id"])
      .executeTakeFirstOrThrow();
    // Another account's claim of the same purchase committed first.
    if (subscription.user_id !== owner) throw new StoreOwnershipError();

    let shortened = false;
    // Where the periods still counting end, as recorded: a revocation 나루
    // already holds outlasts a report that leaves it out.
    let latest: Date | null = null;
    const counts = (end: Date, revokedAt: Date | null) => {
      if (!revokedAt && (!latest || end > latest)) latest = end;
    };
    for (const tx of state.transactions) {
      const before = await trx
        .selectFrom("store_transactions")
        .select(["period_end", "revoked_at"])
        .where("store", "=", state.store)
        .where("store_transaction_id", "=", tx.id)
        .forUpdate()
        .executeTakeFirst();
      if (!before) {
        await trx
          .insertInto("store_transactions")
          .values({
            store_subscription_id: subscription.id,
            user_id: owner,
            store: state.store,
            store_transaction_id: tx.id,
            purchased_at: tx.purchasedAt ?? now,
            period_end: tx.periodEnd,
            revoked_at: tx.revokedAt,
            price_micros: tx.priceMicros ?? null,
            currency: tx.currency ?? null,
          })
          .execute();
        await recordPaymentEvent(trx, {
          kind: tx.revokedAt ? "store_revoked" : "store_charged",
          userId: owner,
          summary: `${STORE_LABELS[state.store]} ${state.productId} ${tx.id}${state.environment === "sandbox" ? " (샌드박스)" : ""}: ${tx.revokedAt ? "회수된 결제" : "결제"}, ${tx.periodEnd.toISOString()}까지`,
        });
        if (tx.revokedAt) shortened = true;
        counts(tx.periodEnd, tx.revokedAt);
        continue;
      }
      const revokedAt = before.revoked_at ?? tx.revokedAt;
      counts(tx.periodEnd, revokedAt);
      const changed =
        before.period_end.getTime() !== tx.periodEnd.getTime() ||
        (revokedAt?.getTime() ?? null) !==
          (before.revoked_at?.getTime() ?? null);
      if (!changed) continue;
      await trx
        .updateTable("store_transactions")
        .set({
          period_end: tx.periodEnd,
          revoked_at: revokedAt,
          updated_at: now,
        })
        .where("store", "=", state.store)
        .where("store_transaction_id", "=", tx.id)
        .execute();
      if (revokedAt && !before.revoked_at) {
        await recordPaymentEvent(trx, {
          kind: "store_revoked",
          userId: owner,
          summary: `${STORE_LABELS[state.store]} ${state.productId} ${tx.id}: 환불·회수되어 이용 기간을 되돌림`,
        });
      }
      if (revokedAt || tx.periodEnd < before.period_end) shortened = true;
    }

    if (state.replacesKey) {
      await trx
        .updateTable("store_subscriptions")
        .set({ status: "expired", auto_renews: false, updated_at: now })
        .where("store", "=", state.store)
        .where("store_key", "=", state.replacesKey)
        .where("user_id", "=", owner)
        .where("status", "in", ["active", "billing_retry"])
        .execute();
    }

    if (latest) await extendPaidTime(trx, owner, latest);
    if (shortened) await recomputePaidTime(trx, owner);
    return { applied: true, userId: owner, subscriptionId: subscription.id };
  });
}

// Marks one charged period revoked (a voided Play order), wherever it is.
export async function revokeStoreTransaction(
  store: Store,
  transactionId: string,
  at: Date,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("store_transactions")
      .select(["user_id", "revoked_at"])
      .where("store", "=", store)
      .where("store_transaction_id", "=", transactionId)
      .executeTakeFirst();
    if (!row || row.revoked_at) return false;
    await lockPaidTime(trx, row.user_id);
    await trx
      .updateTable("store_transactions")
      .set({ revoked_at: at, updated_at: new Date() })
      .where("store", "=", store)
      .where("store_transaction_id", "=", transactionId)
      .execute();
    await recordPaymentEvent(trx, {
      kind: "store_revoked",
      userId: row.user_id,
      summary: `${STORE_LABELS[store]} ${transactionId}: 환불·회수되어 이용 기간을 되돌림`,
    });
    await recomputePaidTime(trx, row.user_id);
    return true;
  });
}

async function accountFor(
  executor: Executor,
  userId: string,
): Promise<string | null> {
  const row = await executor
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .executeTakeFirst();
  return row?.id ?? null;
}

// A store subscription that charges again unless the supporter cancels it in
// the store: 나루 starts no Toss plan or purchase beside it.
export async function renewingStoreSubscription(
  executor: Executor,
  userId: string,
) {
  return executor
    .selectFrom("store_subscriptions")
    .select(["id", "store", "product_id", "expires_at", "status"])
    .where("user_id", "=", userId)
    .where("status", "in", ["active", "billing_retry"])
    .where("auto_renews", "=", true)
    .orderBy("expires_at", "desc")
    .executeTakeFirst();
}

export const STORE_RENEWING_MESSAGE = (store: Store) =>
  `${STORE_LABELS[store]}에서 구독 중입니다. ${STORE_LABELS[store]}에서 구독을 해지한 뒤 결제해 주세요.`;
