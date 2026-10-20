"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";

async function send(url: string, method: string, body: unknown = {}) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.success)
    throw new Error(json.message || "요청을 처리하지 못했어요.");
  return json;
}

/** Runs a request from a button, refreshing the page when it lands. */
function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run(task: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await task();
      toast.success(done);
      router.refresh();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

/** Opens a claim window. The times are the operator's own clock's. */
export function TrialWindowForm() {
  const { busy, run } = useAction();
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [note, setNote] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const saved = await run(
      () =>
        send("/api/admin/trial-windows", "POST", {
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          note,
        }),
      "신청 기간을 추가했어요.",
    );
    if (saved) {
      setStartsAt("");
      setEndsAt("");
      setNote("");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        type="datetime-local"
        aria-label="시작"
        value={startsAt}
        onChange={(event) => setStartsAt(event.target.value)}
        className="h-9 w-56"
        required
      />
      <span className="text-sm text-muted-foreground">~</span>
      <Input
        type="datetime-local"
        aria-label="끝"
        value={endsAt}
        onChange={(event) => setEndsAt(event.target.value)}
        className="h-9 w-56"
        required
      />
      <Input
        aria-label="메모"
        placeholder="메모 (예: 출시 기념)"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="h-9 min-w-48 flex-1"
        maxLength={200}
      />
      <Button type="submit" size="sm" disabled={busy}>
        추가
      </Button>
    </form>
  );
}

/** Ends an open window now, or removes one nobody claimed in. */
export function TrialWindowButtons({
  id,
  open,
  claims,
}: {
  id: string;
  open: boolean;
  claims: number;
}) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const url = `/api/admin/trial-windows/${id}`;

  async function end() {
    if (
      !(await confirm({
        title: "신청 기간을 지금 끝낼까요?",
        description: "이미 시작한 체험은 그대로 이어져요.",
        confirmText: "끝내기",
      }))
    )
      return;
    await run(() => send(url, "PATCH", { end: true }), "신청 기간을 끝냈어요.");
  }

  async function remove() {
    if (
      !(await confirm({
        title: "신청 기간을 지울까요?",
        confirmText: "지우기",
        destructive: true,
      }))
    )
      return;
    await run(() => send(url, "DELETE"), "신청 기간을 지웠어요.");
  }

  return (
    <div className="flex flex-wrap justify-end gap-1">
      {open && (
        <Button size="sm" variant="outline" disabled={busy} onClick={end}>
          지금 끝내기
        </Button>
      )}
      {claims === 0 && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={remove}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          지우기
        </Button>
      )}
    </div>
  );
}
