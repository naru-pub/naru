import { db } from "@/lib/database";
import { paidAccessEndsAt, plansOf } from "@/lib/payments/subscriptions";
import { ONE_TIME_BLOCKING_STATUSES } from "@/lib/payments/payment-states";
import { verifyAppleTransaction, fetchAppleState } from "./apple";
import {
  acknowledgePlaySubscription,
  fetchPlaySubscription,
  playState,
} from "./google";
import {
  applyStoreState,
  StoreVerificationError,
  type AppliedStoreState,
  type StoreState,
} from "./ledger";
import {
  APPLE_PRODUCTS,
  GOOGLE_BASE_PLANS,
  GOOGLE_SUBSCRIPTION,
  STORE_LABELS,
  type Store,
} from "./products";

// What the apps call (app/api/app/v1/supporter) and the stores' notifications
// and reconciliation share: look a purchase up, apply it (ledger.ts), and for
// Play, acknowledge it once granted.

// Transactions the app has: one just bought, or every current one on restore.
// Each is verified against Apple's signature and must be this account's.
export async function claimAppleTransactions(
  userId: string,
  signed: Array<{ transaction: string; renewalInfo?: string | null }>,
): Promise<void> {
  for (const item of signed) {
    const state = await verifyAppleTransaction(item);
    await applyStoreState(state, { claimedBy: userId });
  }
}

export async function claimPlayPurchase(
  userId: string,
  purchaseToken: string,
): Promise<void> {
  const state = await lookUpPlayPurchase(purchaseToken);
  if (!state) throw new StoreVerificationError("Unknown Play purchase");
  const applied = await applyStoreState(state, { claimedBy: userId });
  await acknowledgeIfNeeded(state, applied);
}

export async function lookUpPlayPurchase(
  purchaseToken: string,
): Promise<StoreState | null> {
  const sub = await fetchPlaySubscription(purchaseToken);
  return sub ? playState(purchaseToken, sub) : null;
}

// Acknowledged only once the period is the account's: an unbound purchase is
// left for Play to refund unless the app claims it within three days.
export async function acknowledgeIfNeeded(
  state: StoreState,
  applied: AppliedStoreState,
): Promise<void> {
  if (state.store !== "google" || state.acknowledged || !applied.applied)
    return;
  if (state.status === "expired" || state.status === "revoked") return;
  await acknowledgePlaySubscription(state.productId, state.storeKey);
  await db
    .updateTable("store_subscriptions")
    .set({ acknowledged_at: new Date() })
    .where("id", "=", applied.subscriptionId)
    .execute();
}

// Asks the store again about a subscription 나루 has. Null when it cannot be
// asked (no App Store Server API key) or no longer knows it.
export async function refreshStoreSubscription(row: {
  store: Store;
  store_key: string;
  environment: "sandbox" | "production";
}): Promise<AppliedStoreState | null> {
  const state =
    row.store === "apple"
      ? await fetchAppleState(row.store_key, row.environment)
      : await lookUpPlayPurchase(row.store_key);
  if (!state) {
    await db
      .updateTable("store_subscriptions")
      .set({ synced_at: new Date() })
      .where("store", "=", row.store)
      .where("store_key", "=", row.store_key)
      .execute();
    return null;
  }
  const applied = await applyStoreState(state);
  await acknowledgeIfNeeded(state, applied);
  return applied;
}

export type SupporterStatus = {
  supporter: boolean;
  comp: boolean;
  // Paid access, before the grace window.
  until: string | null;
  // Where the paid time comes from.
  source: "comp" | "toss" | Store | null;
  subscription: {
    store: Store;
    productId: string;
    expiresAt: string;
    autoRenews: boolean;
    status: string;
  } | null;
  // Whether this app may sell the plan now, and why not.
  purchase: { allowed: boolean; message: string | null };
  // appAccountToken / obfuscatedAccountId for the purchase.
  accountToken: string;
  products: string[];
};

// The account's supporter state for the app selling through `store`. One
// recurring plan at a time across Toss and both stores: the app sells
// nothing beside a Toss plan, a renewing subscription in the other store, or
// prepaid Toss time (a store cannot start a plan later, so it would pay twice
// for the overlap). Its own store's subscription is managed there.
export async function supporterStatus(
  userId: string,
  store: Store,
  now = new Date(),
): Promise<SupporterStatus> {
  const user = await db
    .selectFrom("users")
    .select(["supporter_comp", "supporter_until", "supporter_grace"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  const plan = await plansOf(db, userId).select("status").executeTakeFirst();
  const subs = await db
    .selectFrom("store_subscriptions")
    .select(["store", "product_id", "expires_at", "auto_renews", "status"])
    .where("user_id", "=", userId)
    .where("status", "in", ["active", "billing_retry"])
    .orderBy("expires_at", "desc")
    .execute();
  const storePaid = await db
    .selectFrom("store_transactions")
    .select(["store", "period_end"])
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .orderBy("period_end", "desc")
    .executeTakeFirst();

  const comp = user.supporter_comp;
  const until = user.supporter_until;
  const storeUntil = storePaid?.period_end ?? null;
  const paidByStore =
    !!until && !!storeUntil && storeUntil.getTime() >= until.getTime() - 60_000;
  const supporter =
    comp ||
    (!!until &&
      paidAccessEndsAt(until, user.supporter_grace).getTime() > now.getTime());
  const current = subs.find((sub) => sub.store === store) ?? subs[0] ?? null;

  let message: string | null = null;
  if (comp) message = "평생 후원자 계정입니다.";
  else if (plan && ONE_TIME_BLOCKING_STATUSES.includes(plan.status))
    message =
      "나루 웹사이트에서 정기 결제 중입니다. 웹사이트에서 관리해 주세요.";
  else if (subs.some((sub) => sub.store !== store && sub.auto_renews)) {
    const other = subs.find((sub) => sub.store !== store && sub.auto_renews)!;
    message = `${STORE_LABELS[other.store]}에서 구독 중입니다.`;
  } else if (subs.some((sub) => sub.store === store && sub.auto_renews))
    message = `${STORE_LABELS[store]}에서 구독 중입니다.`;
  else if (until && until > now && !paidByStore)
    message = `나루 웹사이트에서 결제한 이용 기간이 ${until.toISOString().slice(0, 10)}까지 남아 있습니다. 기간이 끝난 뒤 구독할 수 있습니다.`;

  return {
    supporter,
    comp,
    until: until?.toISOString() ?? null,
    source: comp
      ? "comp"
      : !until || until <= now
        ? null
        : paidByStore
          ? storePaid!.store
          : "toss",
    subscription: current
      ? {
          store: current.store,
          productId: current.product_id,
          expiresAt: current.expires_at.toISOString(),
          autoRenews: current.auto_renews,
          status: current.status,
        }
      : null,
    purchase: { allowed: message === null, message },
    accountToken: userId,
    products:
      store === "apple"
        ? [...APPLE_PRODUCTS]
        : GOOGLE_BASE_PLANS.map((plan) => `${GOOGLE_SUBSCRIPTION}:${plan}`),
  };
}
