"use client";
import { useState } from "react";
import type { MemberSignInInput } from "@/lib/site-data/member-auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

export default function MemberConsent({
  input,
  account,
  notifications: notificationsBefore,
}: {
  input: MemberSignInInput;
  account: string;
  notifications: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [notifications, setNotifications] = useState(notificationsBefore);
  const [error, setError] = useState("");
  async function approve() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/data-auth/member-authorize", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, notifications }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      window.location.assign(result.redirect);
    } catch (e) {
      setError(e instanceof Error ? e.message : "로그인에 실패했습니다.");
      setBusy(false);
    }
  }
  function deny() {
    const url = new URL(input.redirectUri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("state", input.state);
    window.location.assign(url.href);
  }
  return (
    <div className="max-w-xl mx-auto p-6 space-y-5">
      <h1 className="text-2xl font-bold">{input.site} 회원으로 로그인</h1>
      <p>
        <strong>{account}</strong> 계정으로 <strong>{input.site}</strong>{" "}
        사이트에 회원으로 로그인할까요?
      </p>
      <p className="break-all rounded bg-muted p-3">{input.redirectUri}</p>
      <p>
        사이트는 이 사이트에서만 쓰이는 회원 번호를 받습니다. 나루 아이디와
        이메일은 사이트에 전달되지 않습니다. 회원으로서 사이트가 회원에게 연
        컬렉션의 문서를 읽고 쓰고, 파일을 올릴 수 있습니다. 로그인은 사용하지
        않으면 7일 뒤에, 사용하더라도 30일 뒤에 끝나며, 나루에서 로그아웃하면
        함께 끝납니다. 운영자 승인이 필요한 사이트에서는 승인 후에 회원 기능을
        이용할 수 있습니다.
      </p>
      <label className="flex cursor-pointer items-start gap-3 rounded border border-line p-3">
        <Checkbox
          className="mt-1"
          checked={notifications}
          disabled={busy}
          onCheckedChange={(checked) => setNotifications(checked === true)}
        />
        <span>
          <strong>{input.site}</strong> 사이트의 알림을 나루 앱으로 받기
          <span className="block text-sm text-muted-foreground">
            나루 앱에 로그인한 기기로 알림이 옵니다. 앱의 사이트 탭에서 언제든
            끌 수 있습니다.
          </span>
        </span>
      </label>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <Button disabled={busy} onClick={approve}>
          회원으로 로그인
        </Button>
        <Button disabled={busy} variant="outline" onClick={deny}>
          취소
        </Button>
      </div>
    </div>
  );
}
