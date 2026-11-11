"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";

// Renames the account, moving its site to the new name (lib/account-rename.ts).
export function RenameAccountButton({
  loginName,
  followers,
}: {
  loginName: string;
  followers: number;
}) {
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const confirm = useConfirm();
  async function rename() {
    const to = window
      .prompt(`${loginName} 계정의 새 아이디를 입력해 주세요.`)
      ?.trim()
      .toLowerCase();
    if (!to || to === loginName) return;
    if (
      !(await confirm({
        title: `${loginName} → ${to}`,
        description: `사이트 파일, 데이터베이스, 함수와 복원 지점을 ${to}로 옮깁니다. ${loginName}.naru.pub과 r2 주소의 링크는 더 이상 열리지 않고, 사이트 회원은 다시 로그인해야 합니다.${followers > 0 ? ` 연합우주 팔로워 ${followers}명은 새 주소를 따라오지 않습니다.` : ""} 옮기는 동안 사이트에 쓴 내용은 사라질 수 있습니다.`,
        destructive: true,
      }))
    )
      return;
    setPending(true);
    try {
      const response = await fetch(
        `/api/admin/users/${encodeURIComponent(loginName)}/rename`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to }),
        },
      );
      const body = await response.json();
      if (!response.ok || !body.success)
        throw new Error(body.message ?? "이름을 바꾸지 못했습니다.");
      toast.success(
        `${to}로 바꿨습니다 (파일 ${body.files}개, 데이터 ${body.databaseRows}행).`,
      );
      router.replace(`/admin/users/${encodeURIComponent(to)}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "이름을 바꾸지 못했습니다.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={rename}>
      {pending ? "바꾸는 중…" : "아이디 바꾸기"}
    </Button>
  );
}
