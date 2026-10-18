"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

// Moves an app store subscription to another account of the same person, as
// they asked (lib/payments/store/ledger, moveStoreSubscription).
export function MoveStoreSubscriptionButton({
  subscriptionId,
  from,
}: {
  subscriptionId: string;
  from: string;
}) {
  const [pending, setPending] = useState(false);
  const router = useRouter();
  async function move() {
    const to = window
      .prompt("옮길 계정의 로그인 이름을 입력해 주세요.")
      ?.trim();
    if (!to) return;
    const reason = window.prompt(
      `${from}의 구독과 남은 이용 기간을 ${to}로 옮기는 사유를 입력해 주세요 (200자 이내). 두 계정이 같은 사람의 것인지 확인했나요?`,
    );
    if (!reason?.trim()) return;
    setPending(true);
    try {
      const response = await fetch(
        `/api/admin/store-subscriptions/${subscriptionId}/move`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to, reason }),
        },
      );
      const body = await response.json();
      if (!response.ok || !body.success)
        throw new Error(body.message ?? "구독을 옮기지 못했습니다.");
      toast.success(`구독을 ${to}로 옮겼습니다.`);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "구독을 옮기지 못했습니다.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={move}>
      {pending ? "옮기는 중…" : "다른 계정으로 옮기기"}
    </Button>
  );
}
