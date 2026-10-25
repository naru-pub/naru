"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Checkbox } from "@/components/ui/checkbox";
import { LICENSES } from "@/lib/board/constants";
import type {
  InstallSummary,
  UpdateAction,
  UpdatePlan,
  UpdateResult,
  DisconnectProgress,
} from "@/lib/board/updates";
import { boardRequest, boardStream } from "../board/_components/api";
import {
  TemplateProgress,
  type TemplateProgressStep,
} from "../board/_components/TemplateProgress";

const ACTIONS: Record<UpdateAction, { label: string; className: string }> = {
  create: { label: "+ 새 파일", className: "text-success" },
  update: { label: "~ 바뀜", className: "text-primary" },
  modified: { label: "! 직접 고침 — 보관 후 바꿈", className: "text-warning" },
  overwrite: { label: "! 내 파일 — 보관 후 바꿈", className: "text-warning" },
  delete: { label: "− 지움", className: "text-destructive" },
  keep: { label: "= 직접 고쳐서 남겨 둠", className: "text-muted-foreground" },
};

type DisconnectPhase = DisconnectProgress["phase"] | "forget";
const DISCONNECT_LABELS: Record<DisconnectPhase, string> = {
  forget: "연결을 끊는 중",
  backup: "템플릿 파일을 보관하는 중",
  remove: "템플릿 파일을 지우는 중",
  code: "사이트 코드를 다시 적용하는 중",
};

export function InstallCard({ install }: { install: InstallSummary }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [plan, setPlan] = useState<UpdatePlan | null>(null);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [notify, setNotify] = useState(install.notify);
  const [busy, setBusy] = useState(false);
  // While disconnecting: which way, and how far removing files has got.
  const [disconnecting, setDisconnecting] = useState<{
    removeFiles: boolean;
    progress: TemplateProgressStep<DisconnectPhase> | null;
  } | null>(null);
  const base = `/api/board/installs/${install.id}`;

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    try {
      return await work();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  const review = () =>
    run(async () => {
      const { plan } = await boardRequest<{ plan: UpdatePlan }>(
        `${base}/update/plan`,
        "POST",
        { versionId: install.latest?.id },
      );
      setPlan(plan);
    });

  const update = () =>
    run(async () => {
      const { result } = await boardRequest<{ result: UpdateResult }>(
        `${base}/update`,
        "POST",
        { versionId: plan?.to.id },
      );
      setResult(result);
      setPlan(null);
      toast.success(`v${result.version}로 업데이트했어요.`);
      router.refresh();
    });

  const choose = (value: boolean) =>
    run(async () => {
      await boardRequest(base, "PATCH", { notify: value });
      setNotify(value);
      // A new version shows once notices are on, and hides once off.
      router.refresh();
    });

  const disconnect = async (removeFiles: boolean) => {
    const ok = await confirm(
      removeFiles
        ? {
            title: "템플릿 파일 지우고 연결 끊기",
            description:
              "템플릿이 설치한 그대로인 파일을 /.backup/에 보관하고 지워요. 직접 고친 파일과 이미 적용된 마이그레이션은 남겨 둬요. 데이터베이스의 테이블과 데이터는 그대로예요.",
            confirmText: "지우고 연결 끊기",
            destructive: true,
          }
        : {
            title: "템플릿 연결 끊기",
            description:
              "파일은 그대로 내 것이 되고, 더는 새 버전을 받지 않아요.",
            confirmText: "연결 끊기",
            destructive: true,
          },
    );
    if (!ok) return;
    setDisconnecting({
      removeFiles,
      progress: removeFiles ? null : { phase: "forget", done: 0, total: 1 },
    });
    await run(async () => {
      type Result = {
        removed: number;
        kept: number;
        migrations: number;
        backupPath: string | null;
      };
      const result = removeFiles
        ? await boardStream<Result, DisconnectProgress>(
            base,
            { removeFiles },
            (progress) => setDisconnecting({ removeFiles, progress }),
            "DELETE",
          )
        : (await boardRequest<{ result: Result }>(base, "DELETE", {})).result;
      if (removeFiles)
        toast.success(
          `파일 ${result.removed}개를 지웠어요${result.kept > 0 ? `, 직접 고친 파일 ${result.kept}개는 남겨 뒀어요` : ""}${result.migrations > 0 ? `, 적용된 마이그레이션 ${result.migrations}개는 남겨 뒀어요` : ""}.`,
        );
      router.refresh();
    });
    setDisconnecting(null);
  };

  return (
    <section className="border-2 border-line bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b-2 border-line p-4">
        <div className="min-w-0 space-y-1">
          <Link
            href={`/board/${install.postId}`}
            className="block font-bold hover:underline"
          >
            {install.title}
          </Link>
          <span className="block text-xs text-muted-foreground">
            {install.author}/{install.slug} · /{install.targetPath} ·{" "}
            {LICENSES[install.license].name}
            {install.deleted && " · 작성자가 지운 템플릿"}
          </span>
        </div>
        <span className="font-mono text-sm">
          v{install.version.version}
          {install.latest && (
            <>
              {" "}
              →{" "}
              <strong className="text-primary">
                v{install.latest.version}
              </strong>
            </>
          )}
        </span>
      </div>

      <div className="space-y-4 p-4">
        {install.latest && !plan && (
          <div className="space-y-3">
            <p className="text-sm font-bold">새 버전이 나왔어요</p>
            {install.latest.changelog && (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {install.latest.changelog}
              </p>
            )}
            <Button onClick={review} disabled={busy}>
              {busy && !disconnecting ? "확인하는 중…" : "바뀌는 파일 보기"}
            </Button>
          </div>
        )}

        {plan && (
          <div className="space-y-3">
            <p className="text-sm font-bold">
              v{plan.from.version} → v{plan.to.version}
            </p>
            {plan.changelogs.map((entry) =>
              entry.changelog ? (
                <p
                  key={entry.version}
                  className="whitespace-pre-wrap text-xs text-muted-foreground"
                >
                  v{entry.version}: {entry.changelog}
                </p>
              ) : null,
            )}
            <div className="max-h-72 overflow-y-auto border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-secondary text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-normal">변경</th>
                    <th className="px-3 py-2 font-normal">경로</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.files.map((file) => (
                    <tr key={file.path} className="border-t border-border">
                      <td
                        className={`whitespace-nowrap px-3 py-2 font-bold ${ACTIONS[file.action].className}`}
                      >
                        {ACTIONS[file.action].label}
                      </td>
                      <td className="break-all px-3 py-2 font-mono">
                        /{file.path}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              바뀌지 않는 파일 {plan.unchanged}개는 그대로 둬요. 바꾸거나 지우는
              파일은 모두 /.backup/ 에 보관해요.
            </p>
            {plan.migrations.length > 0 && (
              <p className="border border-border p-3 text-sm">
                <span className="block font-bold">
                  마이그레이션 {plan.migrations.length}개
                </span>
                <span className="block text-xs text-muted-foreground">
                  {plan.migrations.join(", ")} — 업데이트 전에 데이터베이스의
                  복원 지점을 남겨요. 커뮤의 데이터는 그대로예요.
                </span>
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              나루가 새 사이트 코드를 거절하면 모든 파일을 되돌려서 v
              {plan.from.version} 그대로 둬요.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setPlan(null)}
                disabled={busy}
              >
                취소
              </Button>
              <Button onClick={update} disabled={busy}>
                {busy ? "업데이트하는 중…" : `v${plan.to.version}로 업데이트`}
              </Button>
            </div>
          </div>
        )}

        {result && (
          <p className="text-sm text-muted-foreground" role="status">
            v{result.version}로 업데이트했어요. 파일 {result.written}개를 쓰고{" "}
            {result.deleted}개를 지웠어요
            {result.kept > 0 &&
              `, 직접 고친 파일 ${result.kept}개는 남겨 뒀어요`}
            .
            {result.backupPath &&
              ` 원래 파일은 /${result.backupPath}에 있어요.`}
          </p>
        )}

        {!install.latest && !result && (
          <p className="text-sm text-muted-foreground">
            {!notify
              ? "새 버전 알림을 껐어요. 켜면 새 버전을 여기서 받을 수 있어요."
              : "최신 버전이에요."}
          </p>
        )}

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={notify}
            onCheckedChange={(checked) => choose(checked === true)}
            disabled={busy}
          />
          새 버전이 나오면 알려 주기
        </label>

        {disconnecting && (
          <TemplateProgress
            progress={disconnecting.progress}
            labels={DISCONNECT_LABELS}
            note={
              disconnecting.removeFiles
                ? "페이지를 떠나도 끝까지 진행돼요. 중간에 실패하면 파일을 원래대로 되돌려요."
                : "파일은 그대로 두고 연결만 끊어요."
            }
          />
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Button
            type="button"
            variant="link"
            onClick={() => disconnect(false)}
            disabled={busy}
            className="h-auto p-0 text-xs text-destructive"
          >
            연결 끊기 (파일은 그대로 내 것이 돼요)
          </Button>
          <Button
            type="button"
            variant="link"
            onClick={() => disconnect(true)}
            disabled={busy}
            className="h-auto p-0 text-xs text-destructive"
          >
            템플릿 파일 지우고 연결 끊기
          </Button>
        </div>
      </div>
    </section>
  );
}
