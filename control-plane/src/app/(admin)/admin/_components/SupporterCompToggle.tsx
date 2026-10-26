"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";

// Gives the account the supporter plan for free, or takes it back.
export function SupporterCompToggle({
  loginName,
  comp,
}: {
  loginName: string;
  comp: boolean;
}) {
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const confirm = useConfirm();
  async function toggle() {
    const next = !comp;
    if (
      !(await confirm({
        title: next ? "서포터 플랜 무료 제공" : "무료 제공 해제",
        description: next
          ? `${loginName} 계정은 결제 없이 서포터 플랜을 계속 이용합니다. 정기 결제가 있으면 무료 제공 동안 청구되지 않습니다.`
          : `${loginName} 계정의 무료 제공을 끝냅니다. 남은 이용 기한이 없으면 유료 기능이 바로 닫히고, 정기 결제가 있으면 다음 결제일부터 다시 청구됩니다.`,
        destructive: !next,
      }))
    )
      return;
    setPending(true);
    try {
      const response = await fetch(
        `/api/admin/users/${encodeURIComponent(loginName)}/supporter-comp`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comp: next }),
        },
      );
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error("변경 실패");
      toast.success(
        next ? "서포터 플랜을 무료로 제공합니다." : "무료 제공을 해제했습니다.",
      );
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "변경 실패");
    } finally {
      setPending(false);
    }
  }
  return (
    <Button
      size="sm"
      variant={comp ? "outline" : "default"}
      disabled={pending}
      onClick={toggle}
    >
      {comp ? "무료 제공 해제" : "서포터 플랜 무료 제공"}
    </Button>
  );
}
