// The marketplace's rules. Shared by the server and client components, so
// nothing here may import server-only modules.

// Whole hundreds of won between these (board_templates_price_check).
export const MIN_TEMPLATE_PRICE = 1000;
export const MAX_TEMPLATE_PRICE = 1_000_000;

export function isTemplatePrice(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value === 0 ||
      (value >= MIN_TEMPLATE_PRICE &&
        value <= MAX_TEMPLATE_PRICE &&
        value % 100 === 0))
  );
}

// 나루's share of a sale, in percent. Toss's card fee comes out of it, not
// out of the seller's share.
export const MARKET_FEE_PERCENT = 20;

// 나루's share of a sale of `amount` won, rounded down to the won: rounding
// favours the seller.
export function marketFee(amount: number): number {
  return Math.floor((amount * MARKET_FEE_PERCENT) / 100);
}

export function sellerShare(amount: number): number {
  return amount - marketFee(amount);
}

// A buyer may ask for a refund this long after buying, as long as the
// template was never applied: digital content once used is not withdrawn
// (전자상거래법 제17조 제2항 제5호).
export const REFUND_WINDOW_DAYS = 7;

// A sale is paid out only once the refund window has closed, with a margin
// for a refund still being processed.
export const PAYOUT_HOLD_DAYS = 10;

// Payouts below this wait for the next run.
export const MIN_PAYOUT_AMOUNT = 1000;

// On the seller's bank statement; Toss allows seven characters.
export const PAYOUT_DESCRIPTION = "나루템플릿";

// Toss takes 2- or 3-digit 금융결제원 bank codes.
export const BANKS: { code: string; name: string }[] = [
  { code: "004", name: "KB국민은행" },
  { code: "088", name: "신한은행" },
  { code: "020", name: "우리은행" },
  { code: "081", name: "하나은행" },
  { code: "011", name: "NH농협은행" },
  { code: "012", name: "지역농축협" },
  { code: "003", name: "IBK기업은행" },
  { code: "090", name: "카카오뱅크" },
  { code: "092", name: "토스뱅크" },
  { code: "089", name: "케이뱅크" },
  { code: "023", name: "SC제일은행" },
  { code: "027", name: "한국씨티은행" },
  { code: "002", name: "KDB산업은행" },
  { code: "007", name: "Sh수협은행" },
  { code: "031", name: "iM뱅크(대구)" },
  { code: "032", name: "부산은행" },
  { code: "034", name: "광주은행" },
  { code: "035", name: "제주은행" },
  { code: "037", name: "전북은행" },
  { code: "039", name: "경남은행" },
  { code: "045", name: "새마을금고" },
  { code: "048", name: "신협" },
  { code: "050", name: "저축은행" },
  { code: "064", name: "산림조합" },
  { code: "071", name: "우체국" },
];

export function bankName(code: string): string {
  return BANKS.find((bank) => bank.code === code)?.name ?? code;
}

export const SELLER_STATUS_LABELS: Record<string, string> = {
  APPROVAL_REQUIRED: "본인 인증 대기",
  PARTIALLY_APPROVED: "정산 가능 (주 1천만 원 미만)",
  KYC_REQUIRED: "추가 심사(KYC) 필요",
  APPROVED: "정산 가능",
};

export const BUSINESS_TYPE_LABELS: Record<string, string> = {
  INDIVIDUAL: "개인",
  INDIVIDUAL_BUSINESS: "개인사업자",
  CORPORATE: "법인사업자",
};

export const PAYOUT_STATUS_LABELS: Record<string, string> = {
  pending: "요청 중",
  requested: "지급 예정",
  in_progress: "지급 중",
  completed: "지급 완료",
  failed: "지급 실패",
  canceled: "취소됨",
};

export const PURCHASE_STATUS_LABELS: Record<string, string> = {
  pending: "결제 확인 중",
  done: "구매 완료",
  failed: "결제 실패",
  expired: "결제 안 됨",
  canceled: "환불됨",
};

export function won(amount: number): string {
  return `${amount.toLocaleString("ko-KR")}원`;
}
