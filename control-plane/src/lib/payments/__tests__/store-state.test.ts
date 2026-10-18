/** @jest-environment node */
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { generateKeyPairSync, sign } from "node:crypto";
import { Type, AutoRenewStatus } from "@apple/app-store-server-library";
import { appleState } from "@/lib/payments/store/apple";
import {
  playState,
  verifyPushAuthorization,
} from "@/lib/payments/store/google";
import { StoreVerificationError } from "@/lib/payments/store/ledger";

const NOW = new Date("2026-10-19T00:00:00Z");
const LATER = Date.parse("2026-11-19T00:00:00Z");

describe("App Store transactions", () => {
  const transaction = {
    type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
    originalTransactionId: "1000",
    transactionId: "1001",
    productId: "pub.naru.supporter.monthly",
    purchaseDate: Date.parse("2026-10-19T00:00:00Z"),
    expiresDate: LATER,
    appAccountToken: "0190f5a2-0000-7000-8000-000000000001",
    environment: "Production",
    price: 1100000,
    currency: "KRW",
  };

  test("a renewing purchase", () => {
    expect(
      appleState(
        transaction,
        { originalTransactionId: "1000", autoRenewStatus: AutoRenewStatus.ON },
        NOW,
      ),
    ).toMatchObject({
      store: "apple",
      storeKey: "1000",
      environment: "production",
      status: "active",
      autoRenews: true,
      accountToken: transaction.appAccountToken,
      transactions: [
        { id: "1001", periodEnd: new Date(LATER), priceMicros: 1100000000 },
      ],
    });
  });

  test("a refunded one, and one whose renewal is unknown", () => {
    const state = appleState(
      { ...transaction, revocationDate: Date.parse("2026-10-20T00:00:00Z") },
      null,
      NOW,
    );
    expect(state.status).toBe("revoked");
    expect(state.autoRenews).toBeNull();
    expect(state.transactions[0].revokedAt).toEqual(
      new Date("2026-10-20T00:00:00Z"),
    );
  });

  test("refuses anything but the supporter plan", () => {
    expect(() =>
      appleState({ ...transaction, productId: "other" }, null, NOW),
    ).toThrow(StoreVerificationError);
    expect(() =>
      appleState({ ...transaction, type: Type.CONSUMABLE }, null, NOW),
    ).toThrow(StoreVerificationError);
  });
});

describe("Play purchases", () => {
  const purchase = {
    startTime: "2026-10-19T00:00:00Z",
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    externalAccountIdentifiers: {
      obfuscatedExternalAccountId: "0190f5a2-0000-7000-8000-000000000001",
    },
    lineItems: [
      {
        productId: "supporter",
        expiryTime: "2099-11-19T00:00:00Z",
        latestSuccessfulOrderId: "GPA.1234-5678",
        autoRenewingPlan: { autoRenewEnabled: true },
      },
    ],
  };

  test("an active purchase to acknowledge", () => {
    expect(playState("token", purchase)).toMatchObject({
      store: "google",
      storeKey: "token",
      environment: "production",
      status: "active",
      autoRenews: true,
      acknowledged: false,
      transactions: [
        {
          id: "GPA.1234-5678",
          purchasedAt: new Date("2026-10-19T00:00:00Z"),
        },
      ],
    });
  });

  test("a renewal order, a test purchase, a grace period", () => {
    const state = playState("token", {
      ...purchase,
      testPurchase: {},
      subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
      lineItems: [
        {
          ...purchase.lineItems[0],
          latestSuccessfulOrderId: "GPA.1234-5678..0",
        },
      ],
    });
    expect(state).toMatchObject({
      environment: "sandbox",
      status: "billing_retry",
      transactions: [{ id: "GPA.1234-5678..0", purchasedAt: null }],
    });
  });

  test("a pending payment grants nothing", () => {
    expect(
      playState("token", {
        ...purchase,
        subscriptionState: "SUBSCRIPTION_STATE_PENDING",
      }),
    ).toBeNull();
  });
});

describe("Pub/Sub push authentication", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
  const token = (claims: Record<string, unknown>) => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "k1" }),
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = sign(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      privateKey,
    ).toString("base64url");
    return `Bearer ${header}.${payload}.${signature}`;
  };
  const valid = {
    iss: "https://accounts.google.com",
    aud: "https://naru.pub/api/webhooks/google-play",
    email: "play-push@naru.iam.gserviceaccount.com",
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 600,
  };

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.GOOGLE_PLAY_PUSH_AUDIENCE;
    delete process.env.GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT;
  });

  test("accepts only the configured push identity", async () => {
    process.env.GOOGLE_PLAY_PUSH_AUDIENCE = valid.aud;
    process.env.GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT = valid.email;
    jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ keys: [jwk] }));
    expect(await verifyPushAuthorization(token(valid))).toBe(true);
    expect(
      await verifyPushAuthorization(token({ ...valid, aud: "elsewhere" })),
    ).toBe(false);
    expect(
      await verifyPushAuthorization(
        token({ ...valid, email: "someone@example.com" }),
      ),
    ).toBe(false);
    expect(await verifyPushAuthorization(token({ ...valid, exp: 1 }))).toBe(
      false,
    );
    expect(await verifyPushAuthorization(`${token(valid)}x`)).toBe(false);
    expect(await verifyPushAuthorization(null)).toBe(false);
  });

  test("refuses everything when unconfigured", async () => {
    expect(await verifyPushAuthorization(token(valid))).toBe(false);
  });
});
