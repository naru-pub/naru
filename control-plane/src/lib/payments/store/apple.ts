import { readFileSync } from "node:fs";
import {
  AppStoreServerAPIClient,
  AutoRenewStatus,
  Environment,
  SignedDataVerifier,
  Type,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import { APPLE_ROOT_CA_G3 } from "./apple-root-ca";
import { StoreVerificationError, type StoreState } from "./ledger";
import { APPLE_BUNDLE_ID, isStoreProduct } from "./products";

// App Store purchases: StoreKit 2 transactions the app sends, App Store Server
// Notifications V2, and the App Store Server API for reconciliation. Everything
// Apple sends is a JWS whose chain is checked against Apple's root here.
//
// - APPLE_APP_ID: the app's numeric Apple ID, required to accept production
//   transactions (sandbox ones carry none).
// - For reconciliation through the App Store Server API, an In-App Purchase
//   key: APPLE_IAP_KEY_FILE, the path of the .p8 as Apple issued it, or
//   APPLE_IAP_KEY, its PEM with newlines as \n; APPLE_IAP_KEY_ID;
//   APPLE_IAP_ISSUER_ID. Without them notifications and the app still work,
//   and a missed notification waits for the app's next restore.

type AppleEnvironment = Environment.PRODUCTION | Environment.SANDBOX;
const verifiers = new Map<AppleEnvironment, SignedDataVerifier>();

function verifier(environment: string | undefined): SignedDataVerifier {
  // Xcode and local StoreKit testing sign with a local certificate: never
  // accepted. Sandbox is TestFlight and App Review, and is accepted in
  // production so a reviewer's purchase works; its rows say sandbox.
  if (
    environment !== Environment.PRODUCTION &&
    environment !== Environment.SANDBOX
  )
    throw new StoreVerificationError(`Unsupported environment ${environment}`);
  let found = verifiers.get(environment);
  if (!found) {
    const appId = process.env.APPLE_APP_ID
      ? Number(process.env.APPLE_APP_ID)
      : undefined;
    if (environment === Environment.PRODUCTION && !appId)
      throw new StoreVerificationError("APPLE_APP_ID is not configured");
    found = new SignedDataVerifier(
      [APPLE_ROOT_CA_G3],
      true,
      environment,
      APPLE_BUNDLE_ID,
      appId,
    );
    verifiers.set(environment, found);
  }
  return found;
}

// The environment a JWS claims, to pick the verifier that then checks it.
function claimedEnvironment(jws: string, inData = false): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(jws.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return inData ? payload?.data?.environment : payload?.environment;
  } catch {
    return undefined;
  }
}

async function verified<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StoreVerificationError) throw error;
    throw new StoreVerificationError(
      `App Store data failed verification: ${(error as Error)?.message ?? error}`,
    );
  }
}

export async function verifyAppleTransaction(signed: {
  transaction: string;
  renewalInfo?: string | null;
}): Promise<StoreState> {
  const check = verifier(claimedEnvironment(signed.transaction));
  const transaction = await verified(() =>
    check.verifyAndDecodeTransaction(signed.transaction),
  );
  const renewal = signed.renewalInfo
    ? await verified(() =>
        check.verifyAndDecodeRenewalInfo(signed.renewalInfo!),
      )
    : null;
  return appleState(transaction, renewal);
}

export function appleState(
  transaction: JWSTransactionDecodedPayload,
  renewal: JWSRenewalInfoDecodedPayload | null,
  now = new Date(),
): StoreState {
  const {
    originalTransactionId,
    transactionId,
    productId,
    expiresDate,
    purchaseDate,
  } = transaction;
  if (
    transaction.type !== Type.AUTO_RENEWABLE_SUBSCRIPTION ||
    !originalTransactionId ||
    !transactionId ||
    !productId ||
    !expiresDate ||
    !isStoreProduct("apple", productId)
  )
    throw new StoreVerificationError("Not a supporter plan transaction");
  if (
    renewal &&
    renewal.originalTransactionId &&
    renewal.originalTransactionId !== originalTransactionId
  )
    throw new StoreVerificationError("Renewal info of another subscription");
  const expiresAt = new Date(expiresDate);
  const revokedAt = transaction.revocationDate
    ? new Date(transaction.revocationDate)
    : null;
  return {
    store: "apple",
    storeKey: originalTransactionId,
    productId,
    environment:
      transaction.environment === Environment.PRODUCTION
        ? "production"
        : "sandbox",
    accountToken: transaction.appAccountToken ?? null,
    status: revokedAt
      ? "revoked"
      : expiresAt > now
        ? "active"
        : renewal?.isInBillingRetryPeriod
          ? "billing_retry"
          : "expired",
    expiresAt,
    autoRenews: renewal ? renewal.autoRenewStatus === AutoRenewStatus.ON : null,
    transactions: [
      {
        id: transactionId,
        purchasedAt: purchaseDate ? new Date(purchaseDate) : null,
        periodEnd: expiresAt,
        revokedAt,
        // Apple reports milliunits of the currency.
        priceMicros:
          transaction.price != null ? transaction.price * 1000 : null,
        currency: transaction.currency ?? null,
      },
    ],
  };
}

export type AppleNotification = {
  type: string;
  subtype: string | null;
  uuid: string | null;
  // The subscription's state it carried; null for a TEST notification or one
  // about something other than a supporter plan.
  state: StoreState | null;
};

export async function verifyAppleNotification(
  signedPayload: string,
): Promise<AppleNotification> {
  const check = verifier(claimedEnvironment(signedPayload, true));
  const payload = await verified(() =>
    check.verifyAndDecodeNotification(signedPayload),
  );
  const data = payload.data;
  let state: StoreState | null = null;
  if (data?.signedTransactionInfo) {
    const transaction = await verified(() =>
      check.verifyAndDecodeTransaction(data.signedTransactionInfo!),
    );
    const renewal = data.signedRenewalInfo
      ? await verified(() =>
          check.verifyAndDecodeRenewalInfo(data.signedRenewalInfo!),
        )
      : null;
    if (transaction.productId && isStoreProduct("apple", transaction.productId))
      state = appleState(transaction, renewal);
  }
  return {
    type: String(payload.notificationType ?? "(none)"),
    subtype: payload.subtype ? String(payload.subtype) : null,
    uuid: payload.notificationUUID ?? null,
    state,
  };
}

function apiClient(environment: "sandbox" | "production") {
  const key =
    (process.env.APPLE_IAP_KEY_FILE &&
      readFileSync(process.env.APPLE_IAP_KEY_FILE, "utf8")) ||
    process.env.APPLE_IAP_KEY?.replace(/\\n/g, "\n");
  const keyId = process.env.APPLE_IAP_KEY_ID;
  const issuerId = process.env.APPLE_IAP_ISSUER_ID;
  if (!key || !keyId || !issuerId) return null;
  return new AppStoreServerAPIClient(
    key,
    keyId,
    issuerId,
    APPLE_BUNDLE_ID,
    environment === "production" ? Environment.PRODUCTION : Environment.SANDBOX,
  );
}

export function appleApiConfigured(): boolean {
  return !!(
    (process.env.APPLE_IAP_KEY_FILE || process.env.APPLE_IAP_KEY) &&
    process.env.APPLE_IAP_KEY_ID &&
    process.env.APPLE_IAP_ISSUER_ID
  );
}

// The subscription's latest state as the App Store Server API reports it, or
// null when no API key is configured.
export async function fetchAppleState(
  originalTransactionId: string,
  environment: "sandbox" | "production",
): Promise<StoreState | null> {
  const client = apiClient(environment);
  if (!client) return null;
  const response = await client.getAllSubscriptionStatuses(
    originalTransactionId,
  );
  for (const group of response.data ?? [])
    for (const last of group.lastTransactions ?? []) {
      if (
        last.originalTransactionId !== originalTransactionId ||
        !last.signedTransactionInfo
      )
        continue;
      return verifyAppleTransaction({
        transaction: last.signedTransactionInfo,
        renewalInfo: last.signedRenewalInfo,
      });
    }
  return null;
}
