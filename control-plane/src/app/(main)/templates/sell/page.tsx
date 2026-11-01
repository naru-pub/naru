import type { Metadata } from "next";
import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import { findSellerInterest } from "@/lib/board/seller-interest";
import { SellerInterestForm } from "./SellerInterestForm";

export const metadata: Metadata = {
  title: "템플릿 판매 관심 · 나루",
  description: "나루에서 템플릿을 판매하고 싶다면 알려 주세요.",
};

export default async function SellerInterestPage() {
  const { user } = await validateRequest();
  const interest =
    user && user.emailVerifiedAt ? await findSellerInterest(user.id) : null;

  return (
    <div className="bg-background min-h-screen p-4 sm:p-6">
      <main className="mx-auto max-w-2xl space-y-6">
        <div className="space-y-2">
          <Link
            href="/templates"
            className="text-xs text-primary hover:underline"
          >
            ← 템플릿
          </Link>
          <h1 className="text-2xl font-bold">템플릿을 판매하고 싶나요?</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            지금 나루의 템플릿은 모두 무료예요. 유료 판매를 열지는 아직 정하지
            않았고, 얼마나 많은 분이 원하는지 먼저 들어 보고 있어요. 소식이
            있으면 계정 이메일로 알려 드릴게요.
          </p>
        </div>
        {!user ? (
          <p className="border-2 border-line p-5 text-sm text-muted-foreground">
            관심을 알리려면{" "}
            <Link href="/login" className="text-primary underline">
              로그인
            </Link>
            해 주세요.
          </p>
        ) : !user.emailVerifiedAt ? (
          <p className="border-2 border-line p-5 text-sm text-muted-foreground">
            소식을 받을 수 있도록{" "}
            <Link href="/account" className="text-primary underline">
              계정 설정
            </Link>
            에서 이메일을 인증해 주세요.
          </p>
        ) : (
          <SellerInterestForm
            initial={
              interest
                ? {
                    description: interest.description,
                    priceRange: interest.price_range,
                  }
                : null
            }
          />
        )}
      </main>
    </div>
  );
}
