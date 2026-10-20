"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";

// Requires a supporter plan of the account's site's members, or lifts it.
export function SiteMembersFreeToggle({
  loginName,
  free,
}: {
  loginName: string;
  free: boolean;
}) {
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const confirm = useConfirm();
  async function toggle() {
    const next = !free;
    if (
      !(await confirm({
        title: next ? "회원 후원 요구 해제" : "회원 후원 요구",
        description: next
          ? `${loginName} 사이트의 회원은 후원 플랜 없이 로그인할 수 있게 됩니다.`
          : `${loginName} 사이트의 후원 플랜이 없는 회원은 다음 요청부터 이용할 수 없게 됩니다.`,
        destructive: !next,
      }))
    )
      return;
    setPending(true);
    try {
      const response = await fetch(
        `/api/admin/users/${encodeURIComponent(loginName)}/site-members-free`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ free: next }),
        },
      );
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error("변경 실패");
      toast.success(
        next ? "회원 후원 요구를 해제했습니다." : "회원에게 후원을 요구합니다.",
      );
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "변경 실패");
    } finally {
      setPending(false);
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={toggle}>
      {free ? "회원 후원 요구" : "회원 후원 요구 해제"}
    </Button>
  );
}
