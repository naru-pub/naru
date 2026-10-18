// The supporter plan as the Naru apps sell it. Prices are set in App Store
// Connect and the Play Console, not here: the stores charge, and 나루 grants
// whatever period they report a valid purchase of these products paid for.

export type Store = "apple" | "google";

export const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID ?? "pub.naru";
export const GOOGLE_PLAY_PACKAGE =
  process.env.GOOGLE_PLAY_PACKAGE ?? "pub.naru";

// One auto-renewable subscription group in App Store Connect.
export const APPLE_PRODUCTS = [
  "pub.naru.supporter.monthly",
  "pub.naru.supporter.yearly",
] as const;

// One Play subscription with a base plan per interval.
export const GOOGLE_SUBSCRIPTION = "supporter";
export const GOOGLE_BASE_PLANS = ["monthly", "yearly"] as const;

export function isStoreProduct(store: Store, productId: string): boolean {
  return store === "apple"
    ? (APPLE_PRODUCTS as readonly string[]).includes(productId)
    : productId === GOOGLE_SUBSCRIPTION;
}

export const STORE_LABELS: Record<Store, string> = {
  apple: "App Store",
  google: "Google Play",
};
