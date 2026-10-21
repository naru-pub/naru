"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";

// Over every page while an operator views the site as another account
// (/admin/users/[loginName]), with the way back.
export function ImpersonationBanner({ loginName }: { loginName: string }) {
  const [pending, setPending] = useState(false);
  async function end() {
    setPending(true);
    try {
      const response = await fetch("/api/account/impersonation/end", {
        method: "POST",
      });
      const body = await response.json();
      // /admin has another root layout: a full load.
      window.location.href = body.signedIn
        ? `/admin/users/${encodeURIComponent(loginName)}`
        : "/login";
    } catch {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-destructive px-4 py-1.5 text-sm text-destructive-foreground">
      <span>
        운영자로서 <span className="font-mono font-bold">{loginName}</span>{" "}
        계정으로 보는 중입니다.
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={end}
        disabled={pending}
        className="h-7"
      >
        운영으로 돌아가기
      </Button>
    </div>
  );
}
