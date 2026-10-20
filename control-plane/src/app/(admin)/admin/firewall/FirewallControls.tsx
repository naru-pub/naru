"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RULE_ACTION_LABELS } from "@/lib/cloudflare/firewall";

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

const siteUrl = (login: string) =>
  `/api/admin/site-requests/${encodeURIComponent(login)}`;

/** Always block a site, exempt it from its allowance, or clear either. */
export function SiteOverrideButtons({
  login,
  override,
}: {
  login: string;
  override: "block" | "exempt" | null;
}) {
  const { busy, run } = useAction();
  const confirm = useConfirm();

  async function set(mode: "block" | "exempt") {
    const reason = window.prompt(
      mode === "block"
        ? `${login} 사이트를 항상 차단하는 사유 (200자 이내)`
        : `${login} 사이트를 요청 한도에서 빼는 사유 (200자 이내)`,
    );
    if (!reason?.trim()) return;
    await run(
      () => send(siteUrl(login), "PUT", { mode, reason }),
      mode === "block" ? "차단했어요." : "예외로 두었어요.",
    );
  }

  async function clear() {
    if (
      !(await confirm({
        title: `${login} 사이트 지정을 해제할까요?`,
        description: "이번 달 요청 수에 따라 다시 차단되거나 풀려요.",
        confirmText: "해제",
      }))
    )
      return;
    await run(() => send(siteUrl(login), "PUT", { mode: null }), "해제했어요.");
  }

  return (
    <div className="flex flex-wrap justify-end gap-1">
      {override !== "block" && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => set("block")}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          차단
        </Button>
      )}
      {override !== "exempt" && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => set("exempt")}
        >
          예외
        </Button>
      )}
      {override && (
        <Button size="sm" variant="outline" disabled={busy} onClick={clear}>
          지정 해제
        </Button>
      )}
    </div>
  );
}

/** Blocks or exempts a site by its login, busy or not. */
export function SiteOverrideForm() {
  const { busy, run } = useAction();
  const [login, setLogin] = useState("");
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"block" | "exempt">("block");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      await run(
        () => send(siteUrl(login.trim()), "PUT", { mode, reason }),
        mode === "block" ? "차단했어요." : "예외로 두었어요.",
      )
    ) {
      setLogin("");
      setReason("");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="사이트 아이디"
        placeholder="사이트 아이디"
        value={login}
        onChange={(event) => setLogin(event.target.value)}
        className="h-9 w-40"
        required
      />
      <Select
        aria-label="지정"
        value={mode}
        onChange={(event) => setMode(event.target.value as "block" | "exempt")}
        className="h-9"
      >
        <option value="block">항상 차단</option>
        <option value="exempt">차단 예외</option>
      </Select>
      <Input
        aria-label="사유"
        placeholder="사유"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className="h-9 min-w-48 flex-1"
        maxLength={200}
        required
      />
      <Button type="submit" size="sm" disabled={busy}>
        지정
      </Button>
    </form>
  );
}

type RuleFields = { description: string; expression: string; action: string };

/** Adds a custom rule, or with `id` replaces that rule's definition. */
export function RuleForm({
  id,
  initial,
}: {
  id?: string;
  initial?: RuleFields;
}) {
  const { busy, run } = useAction();
  const [fields, setFields] = useState<RuleFields>(
    initial ?? { description: "", expression: "", action: "block" },
  );
  const set = (key: keyof RuleFields) => (value: string) =>
    setFields((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const saved = await run(
      () =>
        id
          ? send(`/api/admin/firewall/rules/${id}`, "PATCH", fields)
          : send("/api/admin/firewall/rules", "POST", fields),
      id ? "규칙을 고쳤어요." : "규칙을 추가했어요.",
    );
    if (saved && !id)
      setFields({ description: "", expression: "", action: "block" });
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="설명"
          placeholder="설명"
          value={fields.description}
          onChange={(event) => set("description")(event.target.value)}
          className="h-9 min-w-48 flex-1"
          maxLength={500}
        />
        <Select
          aria-label="동작"
          value={fields.action}
          onChange={(event) => set("action")(event.target.value)}
          className="h-9"
        >
          {Object.entries(RULE_ACTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <Textarea
        aria-label="조건식"
        placeholder={
          'http.host eq "example.naru.pub" and ip.src.country eq "XX"'
        }
        value={fields.expression}
        onChange={(event) => set("expression")(event.target.value)}
        className="font-mono text-xs"
        rows={3}
        maxLength={4096}
        required
      />
      <Button type="submit" size="sm" disabled={busy}>
        {id ? "고치기" : "규칙 추가"}
      </Button>
    </form>
  );
}

/** Turns a rule on or off, or deletes it. */
export function RuleButtons({
  id,
  enabled,
  description,
}: {
  id: string;
  enabled: boolean;
  description: string;
}) {
  const { busy, run } = useAction();
  const confirm = useConfirm();

  async function remove() {
    if (
      !(await confirm({
        title: "이 규칙을 지울까요?",
        description: description || undefined,
        confirmText: "삭제",
        destructive: true,
      }))
    )
      return;
    await run(
      () => send(`/api/admin/firewall/rules/${id}`, "DELETE"),
      "규칙을 지웠어요.",
    );
  }

  return (
    <div className="flex flex-wrap justify-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          run(
            () =>
              send(`/api/admin/firewall/rules/${id}`, "PATCH", {
                enabled: !enabled,
              }),
            enabled ? "규칙을 껐어요." : "규칙을 켰어요.",
          )
        }
      >
        {enabled ? "끄기" : "켜기"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={remove}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        지우기
      </Button>
    </div>
  );
}
