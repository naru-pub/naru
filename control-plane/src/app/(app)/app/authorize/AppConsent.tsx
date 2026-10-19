"use client";
import { useState } from "react";
import type { AuthorizeInput } from "@/lib/app-api/tokens";
import { Button } from "@/components/ui/button";
import { APP_PANEL } from "../panel";
import SwitchAccount from "@/components/SwitchAccount";

export default function AppConsent({
  input,
  account,
  device,
}: {
  input: AuthorizeInput;
  account: string;
  device: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function approve() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/app/v1/authorize", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: input.client,
          redirect_uri: input.redirectUri,
          state: input.state,
          code_challenge: input.challenge,
          code_challenge_method: "S256",
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message);
      window.location.assign(result.redirect);
    } catch (e) {
      setError(
        e instanceof Error && e.message ? e.message : "연결하지 못했습니다.",
      );
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
    <div className={APP_PANEL}>
      <h1 className="text-2xl font-bold">나루 앱 연결</h1>
      <p>
        <strong>{account}</strong> 계정으로 {device}의 나루 앱에 로그인할까요?
      </p>
      <p>
        앱은 회원으로 가입한 사이트가 보내는 알림을 받고, 어느 사이트의 알림을
        받을지 정할 수 있습니다. 앱에서 로그아웃하면 연결이 끝납니다.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <Button disabled={busy} onClick={approve}>
          앱 연결
        </Button>
        <Button disabled={busy} variant="outline" onClick={deny}>
          취소
        </Button>
      </div>
      <SwitchAccount account={account} />
    </div>
  );
}
