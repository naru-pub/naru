import { db } from "@/lib/database";
import { verifyAppleNotification } from "./apple";
import {
  applyStoreState,
  revokeStoreTransaction,
  StoreVerificationError,
} from "./ledger";
import type { Store } from "./products";
import { acknowledgeIfNeeded, lookUpPlayPurchase } from "./sync";

// The stores' server notifications. Each is kept (store_notifications) with
// what 나루 did about it. A refused one is answered 4xx, a failure 5xx so the
// store sends it again; reconciliation (cli/reconcile-store-subscriptions)
// catches up on any that never arrive.

export type NotificationOutcome = { status: number; outcome: string };

async function record(
  store: Store,
  entry: {
    type: string | null;
    storeKey: string | null;
    payload: unknown;
    outcome: string;
  },
) {
  try {
    await db
      .insertInto("store_notifications")
      .values({
        store,
        notification_type: entry.type,
        store_key: entry.storeKey,
        payload: JSON.stringify(entry.payload ?? null),
        outcome: entry.outcome.slice(0, 2000),
      })
      .execute();
  } catch (error) {
    console.error("[store-notifications] could not record", error);
  }
}

function done(
  store: Store,
  status: number,
  entry: Parameters<typeof record>[1],
): Promise<NotificationOutcome> {
  const line = `[store-notifications] ${store} ${entry.type ?? "(unparsed)"} ${status}: ${entry.outcome}`;
  if (status >= 500) console.error(line);
  else console.log(line);
  return record(store, entry).then(() => ({ status, outcome: entry.outcome }));
}

// App Store Server Notifications V2: { signedPayload }.
export async function handleAppleNotification(
  body: unknown,
): Promise<NotificationOutcome> {
  const signedPayload = (body as { signedPayload?: unknown })?.signedPayload;
  if (typeof signedPayload !== "string")
    return done("apple", 400, {
      type: null,
      storeKey: null,
      payload: null,
      outcome: "refused: no signedPayload",
    });
  let notification;
  try {
    notification = await verifyAppleNotification(signedPayload);
  } catch (error) {
    if (!(error instanceof StoreVerificationError)) throw error;
    return done("apple", 400, {
      type: null,
      storeKey: null,
      payload: null,
      outcome: `refused: ${error.message}`,
    });
  }
  const type = [notification.type, notification.subtype]
    .filter(Boolean)
    .join("/");
  const state = notification.state;
  const entry = {
    type,
    storeKey: state?.storeKey ?? null,
    payload: { uuid: notification.uuid, state },
  };
  if (!state) return done("apple", 200, { ...entry, outcome: "ignored" });
  try {
    const applied = await applyStoreState(state);
    return done("apple", 200, {
      ...entry,
      outcome: applied.applied
        ? `applied: ${state.status} until ${state.expiresAt.toISOString()} (user ${applied.userId})`
        : "unbound: no account to apply it to",
    });
  } catch (error) {
    return done("apple", 500, { ...entry, outcome: `failed: ${error}` });
  }
}

// SUBSCRIPTION_REVOKED: refunded with access taken away.
const PLAY_SUBSCRIPTION_REVOKED = 12;

// A Pub/Sub push: { message: { data: base64 DeveloperNotification } }.
export async function handlePlayNotification(
  body: unknown,
): Promise<NotificationOutcome> {
  const data = (body as { message?: { data?: unknown } })?.message?.data;
  let notification: {
    packageName?: string;
    subscriptionNotification?: {
      notificationType?: number;
      purchaseToken?: string;
    };
    voidedPurchaseNotification?: { orderId?: string; purchaseToken?: string };
    testNotification?: object;
  };
  try {
    notification = JSON.parse(
      Buffer.from(String(data), "base64").toString("utf8"),
    );
  } catch {
    // Pub/Sub would redeliver it forever; it will not parse next time either.
    return done("google", 200, {
      type: null,
      storeKey: null,
      payload: null,
      outcome: "ignored: unreadable message",
    });
  }
  const sub = notification.subscriptionNotification;
  const voided = notification.voidedPurchaseNotification;
  const type = sub
    ? `subscription/${sub.notificationType}`
    : voided
      ? "voided"
      : notification.testNotification
        ? "test"
        : "other";
  const entry = {
    type,
    storeKey: sub?.purchaseToken ?? voided?.purchaseToken ?? null,
    payload: notification,
  };
  try {
    if (voided?.orderId) {
      const revoked = await revokeStoreTransaction(
        "google",
        voided.orderId,
        new Date(),
      );
      return done("google", 200, {
        ...entry,
        outcome: revoked
          ? `revoked ${voided.orderId}`
          : "ignored: unknown order",
      });
    }
    if (!sub?.purchaseToken)
      return done("google", 200, { ...entry, outcome: "ignored" });
    const state = await lookUpPlayPurchase(sub.purchaseToken);
    if (!state)
      return done("google", 200, {
        ...entry,
        outcome: "ignored: not a granted supporter purchase",
      });
    const applied = await applyStoreState(state);
    if (!applied.applied)
      return done("google", 200, {
        ...entry,
        outcome: "unbound: no account to apply it to",
      });
    if (sub.notificationType === PLAY_SUBSCRIPTION_REVOKED)
      for (const tx of state.transactions)
        await revokeStoreTransaction("google", tx.id, new Date());
    await acknowledgeIfNeeded(state, applied);
    return done("google", 200, {
      ...entry,
      outcome: `applied: ${state.status} until ${state.expiresAt.toISOString()} (user ${applied.userId})`,
    });
  } catch (error) {
    if (error instanceof StoreVerificationError)
      return done("google", 200, {
        ...entry,
        outcome: `ignored: ${error.message}`,
      });
    return done("google", 500, { ...entry, outcome: `failed: ${error}` });
  }
}
