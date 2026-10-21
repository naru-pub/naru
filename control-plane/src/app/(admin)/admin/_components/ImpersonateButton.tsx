"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";

// Signs the operator in as the account for an hour, until they return from the
// banner over the site's pages.
export function ImpersonateButton({ loginName }: { loginName: string }) {
  const [pending, setPending] = useState(false);
  const confirm = useConfirm();
  async function impersonate() {
    if (
      !(await confirm({
        title: "이 계정으로 보기",
        description: `${loginName} 계정으로 로그인한 것처럼 나루를 봅니다. 그동안 하는 일은 이 계정이 한 일이 됩니다. 한 시간 뒤나 화면 위의 띠에서 돌아오면 끝납니다.`,
      }))
    )
      return;
    setPending(true);
    try {
      const response = await fetch(
        `/api/admin/users/${encodeURIComponent(loginName)}/impersonate`,
        { method: "POST" },
      );
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error("전환 실패");
      // The site's pages have another root layout: a full load.
      window.location.href = "/files";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "전환 실패");
      setPending(false);
    }
  }
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={impersonate}
    >
      이 계정으로 보기
    </Button>
  );
}
