"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { loadTossPayments } from "@tosspayments/tosspayments-sdk";
import { Button } from "@/components/ui/button";
import { won } from "@/lib/market/constants";
import { boardRequest } from "../../board/_components/api";

// Buying a paid template: an order at the price 나루 records, then Toss's
// payment window on the market MID, which comes back to /market/callback.
export function BuyTemplateButton({
  templateId,
  postId,
  price,
  clientKey,
  loggedIn,
  loginName,
}: {
  templateId: string;
  postId: string;
  price: number;
  clientKey: string;
  loggedIn: boolean;
  loginName: string | null;
}) {
  const [pending, setPending] = useState(false);

  if (!loggedIn) {
    return (
      <Button asChild className="h-12 w-full text-base font-bold">
        <Link href={`/login?next=${encodeURIComponent(`/board/${postId}`)}`}>
          로그인하고 {won(price)}에 사기
        </Link>
      </Button>
    );
  }

  async function buy() {
    if (!clientKey) {
      toast.error("결제 설정이 올바르지 않습니다.");
      return;
    }
    setPending(true);
    try {
      const order = await boardRequest<{
        orderId: string;
        amount: number;
        orderName: string;
        customerKey: string;
      }>(`/api/market/templates/${templateId}/purchase`, "POST");
      const tossPayments = await loadTossPayments(clientKey);
      const payment = tossPayments.payment({ customerKey: order.customerKey });
      const back = `${window.location.origin}/board/${postId}`;
      await payment.requestPayment({
        customerName: loginName ?? undefined,
        method: "CARD",
        amount: { currency: "KRW", value: order.amount },
        orderId: order.orderId,
        orderName: order.orderName,
        successUrl: `${window.location.origin}/market/callback?post=${encodeURIComponent(postId)}`,
        failUrl: `${back}?purchase=failed`,
      });
      // requestPayment leaves the page; control resumes on the callback.
    } catch (error: any) {
      // Closing Toss's window rejects with USER_CANCEL: nothing to say.
      if (error?.code !== "USER_CANCEL") {
        toast.error(error?.message ?? "결제를 시작할 수 없습니다.");
      }
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      onClick={buy}
      disabled={pending}
      className="h-12 w-full text-base font-bold"
    >
      {pending ? "결제 창을 여는 중…" : `${won(price)}에 사기`}
    </Button>
  );
}
