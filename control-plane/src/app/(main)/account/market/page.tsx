import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Store } from "lucide-react";
import { validateRequest } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BUSINESS_TYPE_LABELS,
  MARKET_FEE_PERCENT,
  PAYOUT_HOLD_DAYS,
  PAYOUT_STATUS_LABELS,
  PURCHASE_STATUS_LABELS,
  SELLER_STATUS_LABELS,
  bankName,
  won,
} from "@/lib/market/constants";
import { listPurchases } from "@/lib/market/purchases";
import { sellerEarnings } from "@/lib/market/payouts";
import { findSeller, summarize } from "@/lib/market/sellers";
import { PAYABLE_SELLER_STATUSES } from "@/lib/market/states";
import {
  RefundTemplateButton,
  SellerAccountForm,
  SellerRegistrationForm,
  SyncSellerButton,
} from "./SellerForm";

export const metadata: Metadata = { title: "템플릿 판매와 구매 · 나루" };

function formatDate(value: Date | string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

export default async function MarketAccountPage() {
  const { user } = await validateRequest();
  if (!user) redirect("/login?next=/account/market");

  const [row, earnings, purchases] = await Promise.all([
    findSeller(user.id),
    sellerEarnings(user),
    listPurchases(user),
  ]);
  const seller = row?.toss_seller_id ? summarize(row) : null;

  return (
    <div className="bg-background min-h-screen">
      <div className="mx-auto max-w-4xl space-y-8 p-6">
        <Card className="border-2 border-line bg-card">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2 text-xl font-bold">
              <Store size={20} /> 템플릿 판매
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 p-6">
            {!seller ? (
              <>
                <p className="text-sm text-muted-foreground">
                  템플릿에 가격을 붙이려면 정산받을 정보를 등록해 주세요. 팔린
                  금액에서 수수료 {MARKET_FEE_PERCENT}%를 뺀 금액을, 환불 기간이
                  지난 뒤 일주일마다 계좌로 보내 드려요.
                </p>
                {user.emailVerifiedAt ? (
                  <SellerRegistrationForm email={user.email ?? ""} />
                ) : (
                  <p className="text-sm">
                    먼저{" "}
                    <Link href="/account" className="text-primary underline">
                      계정 설정
                    </Link>
                    에서 이메일을 인증해 주세요.
                  </p>
                )}
              </>
            ) : (
              <>
                <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
                  <dt className="text-muted-foreground">판매자</dt>
                  <dd>
                    {seller.displayName} (
                    {BUSINESS_TYPE_LABELS[seller.businessType]})
                  </dd>
                  <dt className="text-muted-foreground">상태</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    {SELLER_STATUS_LABELS[seller.status]}
                    <SyncSellerButton />
                  </dd>
                  <dt className="text-muted-foreground">정산 계좌</dt>
                  <dd>
                    {bankName(seller.bankCode)} ····{seller.accountLast4} (
                    {seller.holderName})
                  </dd>
                </dl>
                {!PAYABLE_SELLER_STATUSES.includes(seller.status) && (
                  <p className="border border-border bg-secondary p-3 text-xs">
                    {seller.status === "KYC_REQUIRED"
                      ? "토스페이먼츠의 추가 심사(KYC)를 마칠 때까지 정산이 멈춰요. 토스페이먼츠의 안내를 확인해 주세요."
                      : "토스페이먼츠가 보낸 본인 인증 안내를 마치면 정산받을 수 있어요. 그 전에도 템플릿은 팔 수 있고, 판매 금액은 쌓여요."}
                  </p>
                )}
                {earnings && (
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="border border-border p-3">
                      <div className="text-lg font-bold">
                        {won(earnings.unpaid)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        정산 전
                      </div>
                    </div>
                    <div className="border border-border p-3">
                      <div className="text-lg font-bold">
                        {won(earnings.ready)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        다음 정산 ({PAYOUT_HOLD_DAYS}일 지난 판매)
                      </div>
                    </div>
                    <div className="border border-border p-3">
                      <div className="text-lg font-bold">
                        {won(earnings.paidOut)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        받은 금액
                      </div>
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  <h3 className="font-bold">정산 계좌 바꾸기</h3>
                  <SellerAccountForm />
                </div>
              </>
            )}

            {earnings && earnings.payouts.length > 0 && (
              <div className="space-y-2">
                <h3 className="font-bold">정산 내역</h3>
                <ul className="divide-y divide-border border border-border text-sm">
                  {earnings.payouts.map((payout) => (
                    <li
                      key={payout.id}
                      className="flex flex-wrap justify-between gap-2 p-3"
                    >
                      <span>
                        {payout.payoutDate ?? formatDate(payout.createdAt)}
                      </span>
                      <span>{won(payout.amount)}</span>
                      <span className="text-muted-foreground">
                        {PAYOUT_STATUS_LABELS[payout.status]}
                        {payout.error ? ` · ${payout.error}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {earnings && earnings.sales.length > 0 && (
              <div className="space-y-2">
                <h3 className="font-bold">판매 내역</h3>
                <ul className="divide-y divide-border border border-border text-sm">
                  {earnings.sales.map((sale) => (
                    <li
                      key={sale.id}
                      className="flex flex-wrap justify-between gap-2 p-3"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {sale.title}
                      </span>
                      <span>{formatDate(sale.paidAt)}</span>
                      <span>
                        {sale.status === "canceled"
                          ? "환불됨"
                          : `${won(sale.share)} / ${won(sale.amount)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-2 border-line bg-card">
          <CardHeader className="border-b border-border">
            <CardTitle className="text-xl font-bold">산 템플릿</CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            {purchases.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                아직 산 템플릿이 없어요.{" "}
                <Link
                  href="/board?kind=template"
                  className="text-primary underline"
                >
                  템플릿 둘러보기
                </Link>
              </p>
            ) : (
              <ul className="divide-y divide-border border border-border text-sm">
                {purchases.map((purchase) => (
                  <li
                    key={purchase.id}
                    className="flex flex-wrap items-center justify-between gap-2 p-3"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {purchase.postId ? (
                        <Link
                          href={`/board/${purchase.postId}`}
                          className="text-primary underline"
                        >
                          {purchase.title}
                        </Link>
                      ) : (
                        purchase.title
                      )}
                    </span>
                    <span>
                      {formatDate(purchase.paidAt ?? purchase.createdAt)}
                    </span>
                    <span>{won(purchase.amount)}</span>
                    <span className="text-muted-foreground">
                      {PURCHASE_STATUS_LABELS[purchase.status]}
                    </span>
                    {purchase.receiptUrl && (
                      <a
                        href={purchase.receiptUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs underline"
                      >
                        영수증
                      </a>
                    )}
                    {purchase.refundable && (
                      <RefundTemplateButton purchaseId={purchase.id} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
