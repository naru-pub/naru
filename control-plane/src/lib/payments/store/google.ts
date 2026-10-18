import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { GoogleServiceAccount } from "@/lib/google-service-account";
import { StoreVerificationError, type StoreState } from "./ledger";
import { GOOGLE_PLAY_PACKAGE, isStoreProduct } from "./products";

// Google Play purchases: purchase tokens the app sends and Real-Time Developer
// Notifications, both looked up in the Play Developer API — a token says which
// purchase, never what it is worth. Play refunds a purchase that is not
// acknowledged within three days, so 나루 acknowledges once it has granted it.
//
// - GOOGLE_PLAY_SERVICE_ACCOUNT_FILE, the path of the service-account JSON
//   key as Google issued it, or GOOGLE_PLAY_SERVICE_ACCOUNT, the JSON itself.
//   The account needs the Play Console's financial-data and order-management
//   permissions for the app.
// - GOOGLE_PLAY_PUSH_AUDIENCE and GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT: the
//   audience and service-account email of the Pub/Sub push subscription's
//   authentication, checked on every notification.

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
let account: GoogleServiceAccount | null | undefined;

function playAccount(): GoogleServiceAccount {
  if (account === undefined) {
    const json = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE
      ? readFileSync(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE, "utf8")
      : process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
    account = json
      ? new GoogleServiceAccount(
          json,
          "https://www.googleapis.com/auth/androidpublisher",
        )
      : null;
  }
  if (!account) throw new Error("Google Play is not configured");
  return account;
}

export class PlayApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Play Developer API ${status}: ${body.slice(0, 300)}`);
    this.name = "PlayApiError";
  }
}

async function play(path: string, init: RequestInit = {}) {
  const response = await fetch(
    `${API}/applications/${GOOGLE_PLAY_PACKAGE}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${await playAccount().accessToken()}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new PlayApiError(response.status, text);
  return text ? JSON.parse(text) : {};
}

// The parts of a SubscriptionPurchaseV2 read here.
export type PlaySubscription = {
  startTime?: string;
  subscriptionState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  testPurchase?: object;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
  }>;
};

export async function fetchPlaySubscription(
  purchaseToken: string,
): Promise<PlaySubscription | null> {
  try {
    return await play(
      `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
    );
  } catch (error) {
    // A token Play does not know, or one for another app.
    if (error instanceof PlayApiError && [400, 404, 410].includes(error.status))
      return null;
    throw error;
  }
}

// Null for a purchase that grants nothing yet (pending payment) or is not a
// supporter plan.
export function playState(
  purchaseToken: string,
  sub: PlaySubscription,
): StoreState | null {
  const line = sub.lineItems?.[0];
  const productId = line?.productId;
  if (!line || !productId || !line.expiryTime) return null;
  if (!isStoreProduct("google", productId))
    throw new StoreVerificationError("Not a supporter plan purchase");
  const state = sub.subscriptionState ?? "";
  if (
    state === "SUBSCRIPTION_STATE_PENDING" ||
    state === "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED"
  )
    return null;
  const expiresAt = new Date(line.expiryTime);
  const orderId = line.latestSuccessfulOrderId ?? sub.latestOrderId;
  return {
    store: "google",
    storeKey: purchaseToken,
    productId,
    environment: sub.testPurchase ? "sandbox" : "production",
    accountToken:
      sub.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    status:
      state === "SUBSCRIPTION_STATE_ACTIVE" ||
      state === "SUBSCRIPTION_STATE_CANCELED"
        ? expiresAt > new Date()
          ? "active"
          : "expired"
        : state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" ||
            state === "SUBSCRIPTION_STATE_ON_HOLD"
          ? "billing_retry"
          : "expired",
    expiresAt,
    autoRenews: line.autoRenewingPlan?.autoRenewEnabled ?? false,
    acknowledged:
      sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    replacesKey: sub.linkedPurchaseToken ?? null,
    transactions: orderId
      ? [
          {
            id: orderId,
            // Renewal orders end in "..N"; the first one began the purchase.
            purchasedAt:
              !orderId.includes("..") && sub.startTime
                ? new Date(sub.startTime)
                : null,
            periodEnd: expiresAt,
            revokedAt: null,
          },
        ]
      : [],
  };
}

export async function acknowledgePlaySubscription(
  productId: string,
  purchaseToken: string,
): Promise<void> {
  await play(
    `/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
    { method: "POST", body: "{}" },
  );
}

// Switches auto-renewal off; the paid period runs out as bought.
export async function cancelPlaySubscription(
  productId: string,
  purchaseToken: string,
): Promise<void> {
  await play(
    `/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:cancel`,
    { method: "POST", body: "{}" },
  );
}

// Subscription orders Play refunded or charged back since `since`.
export async function voidedPlayOrders(
  since: Date,
): Promise<Array<{ orderId: string; voidedAt: Date }>> {
  const orders: Array<{ orderId: string; voidedAt: Date }> = [];
  let token: string | undefined;
  do {
    const query = new URLSearchParams({
      startTime: String(since.getTime()),
      type: "1", // subscriptions too
      maxResults: "1000",
    });
    if (token) query.set("token", token);
    const page = await play(`/purchases/voidedpurchases?${query}`);
    for (const voided of page.voidedPurchases ?? [])
      if (voided.orderId)
        orders.push({
          orderId: voided.orderId,
          voidedAt: new Date(Number(voided.voidedTimeMillis)),
        });
    token = page.tokenPagination?.nextPageToken;
  } while (token);
  return orders;
}

export function playConfigured(): boolean {
  return !!(
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE ||
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT
  );
}

// Pub/Sub push requests carry a Google-signed OIDC token for the push
// subscription's service account.
let googleKeys: { keys: Map<string, JsonWebKey>; until: number } | null = null;

async function googleSigningKey(kid: string): Promise<JsonWebKey | null> {
  if (
    !googleKeys ||
    googleKeys.until < Date.now() ||
    !googleKeys.keys.has(kid)
  ) {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Google certs ${response.status}`);
    const { keys } = (await response.json()) as {
      keys: Array<JsonWebKey & { kid: string }>;
    };
    googleKeys = {
      keys: new Map(keys.map((key) => [key.kid, key])),
      until: Date.now() + 60 * 60 * 1000,
    };
  }
  return googleKeys.keys.get(kid) ?? null;
}

export async function verifyPushAuthorization(
  authorization: string | null,
  now = Date.now(),
): Promise<boolean> {
  const audience = process.env.GOOGLE_PLAY_PUSH_AUDIENCE;
  const email = process.env.GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT;
  if (!audience || !email) return false;
  const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
  const [header, payload, signature] = token?.split(".") ?? [];
  if (!header || !payload || !signature) return false;
  try {
    const { alg, kid } = JSON.parse(
      Buffer.from(header, "base64url").toString(),
    );
    if (alg !== "RS256" || typeof kid !== "string") return false;
    const jwk = await googleSigningKey(kid);
    if (!jwk) return false;
    const valid = verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    );
    if (!valid) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    return (
      ["accounts.google.com", "https://accounts.google.com"].includes(
        claims.iss,
      ) &&
      claims.aud === audience &&
      claims.email === email &&
      claims.email_verified === true &&
      typeof claims.exp === "number" &&
      claims.exp * 1000 > now
    );
  } catch {
    return false;
  }
}
