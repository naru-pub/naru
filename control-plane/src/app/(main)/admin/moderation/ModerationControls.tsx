"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Level = "hidden" | "suspended" | null;

const DONE: Record<string, string> = {
  hidden: "목록에서 숨겼어요.",
  suspended: "서비스를 중지했어요.",
  none: "조치를 해제했어요.",
};

/** Sets a site's moderation level, with the reason the history keeps. */
export function ModerationForm({
  login,
  level,
}: {
  login: string;
  level: Level;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [next, setNext] = useState<string>(level ?? "none");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      next === "suspended" &&
      !(await confirm({
        title: `${login} 사이트의 서비스를 중지할까요?`,
        description:
          "페이지, 파일, 사용자 도메인, 데이터, 앱 알림이 모두 멈춰요.",
        confirmText: "서비스 중지",
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/moderation/${encodeURIComponent(login)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            level: next === "none" ? null : next,
            reason,
          }),
        },
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.success)
        throw new Error(json.message || "요청을 처리하지 못했어요.");
      if (json.failures?.length)
        toast.warning(
          `저장했지만 적용하지 못했어요: ${json.failures.join(", ")}. 다음 작업에서 다시 시도해요.`,
        );
      else toast.success(DONE[next]);
      setReason("");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Select
        aria-label="조치"
        value={next}
        onChange={(event) => setNext(event.target.value)}
        className="h-9"
      >
        <option value="none">조치 없음</option>
        <option value="hidden">
          목록에서 숨김 — 둘러보기, 검색, 사이트 목록에서 뺌
        </option>
        <option value="suspended">
          서비스 중지 — 나루에서 사이트를 서비스하지 않음
        </option>
      </Select>
      <Textarea
        aria-label="사유"
        placeholder="사유 (기록에 남고 운영 Discord에 알려요)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={500}
        required
      />
      <Button
        type="submit"
        size="sm"
        disabled={busy || next === (level ?? "none")}
        variant={next === "suspended" ? "destructive" : "default"}
      >
        적용
      </Button>
    </form>
  );
}

/** Opens a site's moderation page by its login name. */
export function SiteLookup() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const name = login.trim().toLowerCase();
        if (name) router.push(`/admin/moderation/${encodeURIComponent(name)}`);
      }}
    >
      <Input
        aria-label="사이트 아이디"
        placeholder="사이트 아이디"
        value={login}
        onChange={(event) => setLogin(event.target.value)}
        className="h-9 w-48"
      />
      <Button type="submit" size="sm" variant="outline">
        열기
      </Button>
    </form>
  );
}
