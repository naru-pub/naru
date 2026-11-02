"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Gift } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function TrialPitch({ days }: { days: number }) {
  return (
    <>
      데이터베이스, 방문자 현황, GitHub 배포, MCP 연결을 {days}일 동안 무료로 써
      보세요. 커스텀 도메인은 체험에 포함되지 않습니다. 카드 등록은 필요 없고,
      체험이 끝나도 자동으로 결제되지 않습니다. 이메일 주소 하나당 한 번 이용할
      수 있습니다.
    </>
  );
}

// The free trial of the supporter plan (lib/supporter-trial), offered to an
// account that may claim it and shown while it runs. lib/supporter-trial
// pulls in node:crypto, so its TRIAL_DAYS comes in as a prop.
export function TrialCard({
  days,
  endsAt,
}: {
  days: number;
  // Set while the trial runs; otherwise the account may claim it.
  endsAt: string | null;
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
            까지 커스텀 도메인을 제외한 유료 기능을 무료로 이용할 수 있습니다.
            체험 중에 결제해도 남은 체험 기간은 그대로이고, 첫 결제는 체험이
            끝난 뒤입니다. 커스텀 도메인은 결제하는 즉시 쓸 수 있습니다.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground">
              <TrialPitch days={days} />
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

// The trial offered to an account that lacks only a verified email. Most have
// no address at all, so it asks for one here; the mail's link comes back to
// /supporter, where TrialCard takes over.
export function TrialVerifyCard({
  days,
  pendingEmail,
}: {
  days: number;
  // The address a verification mail still waits on, if any.
  pendingEmail: string | null;
}) {
  const [email, setEmail] = useState(pendingEmail ?? "");
  const [sentTo, setSentTo] = useState(pendingEmail);
  const [pending, setPending] = useState(false);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      const res = await fetch("/api/account/associate-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, next: "/supporter" }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(data.message);
        setSentTo(email);
      } else {
        toast.error(data.message ?? "인증 이메일을 보내지 못했습니다.");
      }
    } catch {
      toast.error("인증 이메일 발송 중 오류가 발생했습니다.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="rounded-none bg-card border-2 border-line">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Gift size={20} />
          {days}일 무료 체험
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4 text-sm">
        <p className="text-muted-foreground">
          <TrialPitch days={days} />{" "}
          <strong className="text-foreground">
            이메일을 인증하면 바로 시작할 수 있습니다.
          </strong>
        </p>
        {sentTo && (
          <p className="text-muted-foreground">
            <strong className="text-foreground">{sentTo}</strong> 주소로 보낸
            인증 메일의 링크를 열어 주세요.
          </p>
        )}
        <form onSubmit={send} className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="email"
            required
            aria-label="이메일 주소"
            placeholder="your@email.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="sm:max-w-xs"
          />
          <Button type="submit" disabled={pending}>
            {pending
              ? "발송 중..."
              : sentTo
                ? "인증 메일 다시 받기"
                : "인증 메일 받기"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
