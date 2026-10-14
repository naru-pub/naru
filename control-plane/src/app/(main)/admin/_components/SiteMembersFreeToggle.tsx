"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";

// Exempts the account's site from the supporter plan its members need.
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
        title: next ? "회원 후원 요건 면제" : "면제 해제",
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
        next ? "회원 후원 요건을 면제했습니다." : "면제를 해제했습니다.",
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
      {free ? "회원 후원 면제 해제" : "회원 후원 면제"}
    </Button>
  );
}
