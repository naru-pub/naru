"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

const POLL_MS = 1500;
const POLLS = 40;

// Toss sends the buyer here after the payment window. The order is handed
// to 나루, whose task approves it; this waits for the outcome and goes back
// to the template.
function Callback() {
  const router = useRouter();
  const params = useSearchParams();
  const ran = useRef(false);
  const [message, setMessage] = useState("결제를 확인하고 있어요…");
  const postId = params.get("post");
  const back = postId ? `/board/${postId}` : "/account/market";

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const paymentKey = params.get("paymentKey");
    const orderId = params.get("orderId");
    const amount = params.get("amount");
    if (!paymentKey || !orderId || !amount) {
      router.replace(back);
      return;
    }

    (async () => {
      try {
        const res = await fetch("/api/market/purchases/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setMessage(data.message ?? "결제를 확인하지 못했어요.");
          return;
        }
        for (let poll = 0; poll < POLLS; poll += 1) {
          const status = await fetch(`/api/market/purchases/${data.purchaseId}`)
            .then((r) => r.json())
            .catch(() => null);
          const state = status?.purchase?.status;
          if (state === "done") {
            router.replace(`${back}?purchase=done`);
            return;
          }
          if (state && state !== "pending") {
            setMessage("결제가 승인되지 않았어요. 카드에는 청구되지 않습니다.");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        setMessage(
          "결제 확인이 늦어지고 있어요. 확인되면 템플릿을 적용할 수 있어요.",
        );
      } catch {
        setMessage(
          "결제 확인이 늦어지고 있어요. 잠시 후 이 페이지를 새로고침해 주세요.",
        );
      }
    })();
  }, [params, router, back]);

  return (
    <div className="mx-auto max-w-xl space-y-4 p-8 text-center text-muted-foreground">
      <p>{message}</p>
      <Link href={back} className="text-sm text-primary underline">
        템플릿으로 돌아가기
      </Link>
    </div>
  );
}

export default function MarketCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-xl p-8 text-center text-muted-foreground">
          결제를 확인하고 있어요…
        </div>
      }
    >
      <Callback />
    </Suspense>
  );
}
