// The choices on the seller interest form, for the form and the server alike.
export const SELLER_INTEREST_PRICES = {
  under_10k: "1만 원 미만",
  "10k_30k": "1만~3만 원",
  "30k_100k": "3만~10만 원",
  over_100k: "10만 원 이상",
  unsure: "아직 모르겠어요",
} as const;

export type SellerInterestPrice = keyof typeof SELLER_INTEREST_PRICES;

export const MAX_SELLER_INTEREST_LENGTH = 2000;
