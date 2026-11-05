// What 나루 sells for, in KRW. Apart from lib/payments/toss.ts, which pulls in
// crypto, so client components can show the prices the server charges.

export type BillingInterval = "month" | "year";

// Authoritative server-side amounts. Never trust client-sent amounts.
export const PLAN_AMOUNTS: Record<BillingInterval, number> = {
  month: 1000,
  year: 10000,
};

// One-time donation: pay once for 1 year (no auto-renewal). Priced above the
// recurring annual plan since there's no retention commitment.
export const ONE_TIME_YEAR_AMOUNT = 12000;
