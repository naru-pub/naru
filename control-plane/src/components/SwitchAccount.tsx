"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";

// Another account: sign naru.pub out, and the page asks to sign in again.
export default function SwitchAccount({ account }: { account: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signOut() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.message);
      window.location.reload();
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "로그아웃하지 못했습니다.",
      );
      setBusy(false);
    }
  }
  return (
    <div className="border-t border-border pt-4 text-sm text-muted-foreground">
      <p>다른 계정으로 로그인하려면 먼저 로그아웃하세요.</p>
      <Button
        variant="link"
        disabled={busy}
        onClick={signOut}
        className="h-auto p-0"
      >
        {account} 계정에서 로그아웃
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
