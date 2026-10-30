// The states the marketplace's rows can be in. The database checks the same
// lists (migration 1793399996767_template_marketplace).

export const SELLER_BUSINESS_TYPES = [
  "INDIVIDUAL",
  "INDIVIDUAL_BUSINESS",
  "CORPORATE",
] as const;
export type SellerBusinessType = (typeof SELLER_BUSINESS_TYPES)[number];

// Toss's seller statuses (지급대행 가이드).
export const SELLER_STATUSES = [
  // Registered; an individual has not verified their identity yet.
  "APPROVAL_REQUIRED",
  // Paid up to 10,000,000 won a week.
  "PARTIALLY_APPROVED",
  // Over the weekly limit or due for its periodic review: not paid until
  // KYC passes.
  "KYC_REQUIRED",
  "APPROVED",
] as const;
export type SellerStatus = (typeof SELLER_STATUSES)[number];

// The statuses Toss pays out to.
export const PAYABLE_SELLER_STATUSES: readonly SellerStatus[] = [
  "PARTIALLY_APPROVED",
  "APPROVED",
];

export const PURCHASE_STATUSES = [
  // Ordered; the buyer may still be in Toss's window, or its confirm is
  // queued.
  "pending",
  "done",
  // Declined on its merits.
  "failed",
  // Never approved: the window closed, or Toss ended the order.
  "expired",
  // Refunded in full.
  "canceled",
] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const PAYOUT_STATUSES = [
  // Recorded with its purchases, not yet accepted by Toss.
  "pending",
  // Toss accepted it (REQUESTED).
  "requested",
  "in_progress",
  "completed",
  // Toss refused it, or the transfer failed: its purchases are freed for
  // the next one.
  "failed",
  "canceled",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const OPEN_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  "pending",
  "requested",
  "in_progress",
];

export function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}
