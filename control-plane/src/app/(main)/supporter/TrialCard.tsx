"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Gift } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// The free trial of the supporter plan (lib/supporter-trial), offered to an
// account that may claim it and shown while it runs. lib/supporter-trial
// pulls in node:crypto, so its TRIAL_DAYS comes in as a prop.
export function TrialCard({
  days,
  endsAt,
  claimUntil,
}: {
  days: number;
  // Set while the trial runs; otherwise the account may claim it.
  endsAt: string | null;
  // When the claim window closes, while the account may claim.
  claimUntil: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function claim() {
    setPending(true);
    try {
      const res = await fetch("/api/account/supporter-trial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(data.message);
        router.refresh();
      } else {
        toast.error(data.message ?? "무료 체험을 시작하지 못했습니다.");
      }
    } catch {
      toast.error("무료 체험을 시작하는 중 오류가 발생했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="rounded-none bg-card border-2 border-line">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Gift size={20} />
          {endsAt ? "무료 체험 중" : `${days}일 무료 체험`}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4 text-sm">
        {endsAt ? (
          <p className="text-muted-foreground">
            <strong className="text-foreground">
              {new Date(endsAt).toLocaleDateString("ko-KR", {
                timeZone: "Asia/Seoul",
              })}
            </strong>
            까지 유료 기능을 모두 무료로 이용할 수 있습니다. 체험 중에 결제해도
            남은 체험 기간은 그대로이고, 첫 결제는 체험이 끝난 뒤입니다.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground">
              커스텀 도메인, 데이터베이스, 방문자 현황, GitHub 배포를 {days}일
              동안 무료로 써 보세요. 카드 등록은 필요 없고, 체험이 끝나도
              자동으로 결제되지 않습니다. 이메일 주소 하나당 한 번 이용할 수
              있습니다.
              {claimUntil && (
                <>
                  {" "}
                  <strong className="text-foreground">
                    {new Date(claimUntil).toLocaleString("ko-KR", {
                      timeZone: "Asia/Seoul",
                      dateStyle: "long",
                      timeStyle: "short",
                    })}
                  </strong>
                  까지 시작할 수 있습니다.
                </>
              )}
            </p>
            <Button onClick={claim} disabled={pending}>
              무료 체험 시작하기
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
