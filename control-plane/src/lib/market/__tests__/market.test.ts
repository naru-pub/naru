/** @jest-environment node */
import { describe, expect, jest, test } from "@jest/globals";
import {
  decryptJwe,
  encryptJwe,
  isCompactJwe,
  kstTimestamp,
  securityKeyBytes,
} from "@/lib/market/jwe";
import {
  isTemplatePrice,
  marketFee,
  sellerShare,
} from "@/lib/market/constants";
import { nextPayoutDate } from "@/lib/market/payouts";

jest.mock("@/lib/database", () => ({ db: {} }));
jest.mock("@/lib/payments/payment-jobs", () => ({ enqueueJob: jest.fn() }));

const KEY = securityKeyBytes("00112233445566778899aabbccddeeff".repeat(2));

describe("Toss's ENCRYPTION mode", () => {
  test("round-trips a body as a direct A256GCM compact JWE", () => {
    const token = encryptJwe('{"refSellerId":"naru1234567"}', KEY, {
      now: new Date("2026-01-01T00:00:00Z"),
      nonce: "n-1",
    });
    expect(isCompactJwe(token)).toBe(true);
    const [header, encryptedKey] = token.split(".");
    expect(encryptedKey).toBe("");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "dir",
      enc: "A256GCM",
      iat: "2026-01-01T09:00:00+09:00",
      nonce: "n-1",
    });
    expect(decryptJwe(token, KEY)).toBe('{"refSellerId":"naru1234567"}');
  });

  test("refuses a token changed in transit", () => {
    const token = encryptJwe("{}", KEY);
    const parts = token.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptJwe(parts.join("."), KEY)).toThrow();
  });

  test("takes only a 64-character hex key", () => {
    expect(() => securityKeyBytes("abc")).toThrow();
    expect(securityKeyBytes("ab".repeat(32))).toHaveLength(32);
  });

  test("tells a JWE from JSON", () => {
    expect(isCompactJwe('{"version":"2024-06-01"}')).toBe(false);
  });

  test("states iat in KST", () => {
    expect(kstTimestamp(new Date("2026-10-31T16:30:00Z"))).toBe(
      "2026-11-01T01:30:00+09:00",
    );
  });
});

describe("prices and shares", () => {
  test.each([
    [0, true],
    [1000, true],
    [12300, true],
    [999, false],
    [1050, false],
    [1_000_100, false],
    [-1000, false],
    ["1000", false],
  ])("%p is a price: %p", (value, expected) => {
    expect(isTemplatePrice(value)).toBe(expected);
  });

  test("the seller's share is what the fee leaves, rounded their way", () => {
    expect(marketFee(10000)).toBe(2000);
    expect(sellerShare(10000)).toBe(8000);
    expect(marketFee(1100)).toBe(220);
    expect(marketFee(1300) + sellerShare(1300)).toBe(1300);
  });
});

describe("payout dates", () => {
  test.each([
    // Monday 10:00 KST → Tuesday.
    ["2026-11-02T01:00:00Z", "2026-11-03"],
    // Friday → Monday.
    ["2026-11-06T01:00:00Z", "2026-11-09"],
    // Saturday → Monday.
    ["2026-11-07T01:00:00Z", "2026-11-09"],
    // Sunday 23:30 KST (14:30 UTC) is already Sunday in Seoul → Monday.
    ["2026-11-08T14:30:00Z", "2026-11-09"],
    // Friday 23:30 UTC is Saturday 08:30 KST → Monday.
    ["2026-11-06T23:30:00Z", "2026-11-09"],
  ])("from %s: %s", (now, expected) => {
    expect(nextPayoutDate(new Date(now))).toBe(expected);
  });
});
