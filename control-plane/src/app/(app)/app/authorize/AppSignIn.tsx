"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The app's own sign-in form, so it never sends the person to /login, whose
// site layout links everywhere. Signing in reloads this page, which then asks
// to connect the app.
export default function AppSignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          login_name: form.get("login_name"),
          password: form.get("password"),
        }),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.message);
      window.location.reload();
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "로그인 중 오류가 발생했습니다.",
      );
      setBusy(false);
    }
  }
  return (
    <div className="bg-card border-2 border-line rounded-lg p-6 space-y-5">
      <div className="text-center space-y-1">
        <h1 className="text-2xl font-bold">나루 앱 로그인</h1>
        <p className="text-muted-foreground">
          나루 계정으로 로그인하면 앱으로 돌아갑니다.
        </p>
      </div>
      <form onSubmit={signIn} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="login_name">아이디</Label>
          <Input
            id="login_name"
            name="login_name"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">비밀번호</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="w-full">
          로그인
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        계정 만들기와 비밀번호 찾기는 웹 브라우저에서 naru.pub에 접속해 할 수
        있습니다.
      </p>
    </div>
  );
}
