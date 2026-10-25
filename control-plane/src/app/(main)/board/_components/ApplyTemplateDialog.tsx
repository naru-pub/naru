"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select } from "@/components/ui/select";
import { formatBytes, type UpdatePreference } from "@/lib/board/constants";
import type {
  ApplicationPlan,
  ApplicationResult,
  ApplyProgress,
} from "@/lib/board/templates";
import { boardRequest, boardStream } from "./api";
import CollectionName from "@/components/CollectionName";

type Step =
  | { name: "where" }
  | { name: "review"; plan: ApplicationPlan }
  | { name: "done"; result: ApplicationResult };

const PHASE_LABELS: Record<ApplyProgress["phase"], string> = {
  backup: "원래 파일을 보관하는 중",
  copy: "파일을 복사하는 중",
  code: "사이트 코드를 적용하는 중",
  collections: "컬렉션을 만드는 중",
};

/** Where an application has got, while it runs. */
function ApplyProgressBar({ progress }: { progress: ApplyProgress | null }) {
  const label = progress ? PHASE_LABELS[progress.phase] : "시작하는 중";
  const counted = progress && progress.total > 1;
  const percent =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;
  return (
    <div role="status" aria-live="polite" className="space-y-2">
      <div className="flex justify-between gap-3 text-sm">
        <span className="font-bold">{label}…</span>
        {counted && (
          <span className="text-muted-foreground">
            {progress.done} / {progress.total}
          </span>
        )}
      </div>
      <div
        className="h-2 w-full overflow-hidden bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={counted ? percent : undefined}
      >
        <div
          className={`h-full bg-primary transition-[width] ${counted ? "" : "animate-pulse"}`}
          style={{ width: counted ? `${percent}%` : "100%" }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        페이지를 떠나도 적용은 끝까지 진행돼요. 중간에 실패하면 사이트를
        원래대로 되돌려요.
      </p>
    </div>
  );
}

export function ApplyTemplateDialog({
  title,
  slug,
  authorLoginName,
  versions,
  samplePath,
  siteUrl,
}: {
  title: string;
  slug: string;
  authorLoginName: string;
  // siteCode: the version has its own site code, so it installs at the root.
  versions: { id: string; version: number; siteCode: boolean }[];
  // One of the template's files, to show where applying would put it.
  samplePath: string;
  // The viewer's site, or null when nobody is signed in.
  siteUrl: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ name: "where" });
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [mode, setMode] = useState<"folder" | "root">("folder");
  const [folder, setFolder] = useState(slug);
  const [backup, setBackup] = useState(true);
  const [createCollections, setCreateCollections] = useState(true);
  const [updates, setUpdates] = useState<UpdatePreference>("notify");
  const [busy, setBusy] = useState(false);
  // Set while applying: null until the first progress line arrives.
  const [applying, setApplying] = useState<{
    progress: ApplyProgress | null;
  } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const siteCode =
    versions.find((version) => version.id === versionId)?.siteCode ?? false;
  const effectiveMode = siteCode ? "root" : mode;
  const targetPath = effectiveMode === "root" ? "" : folder;
  const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, "");
  const targetPrefix =
    effectiveMode === "root" || !cleanFolder ? "" : `${cleanFolder}/`;

  async function review() {
    if (effectiveMode === "folder" && !folder.trim()) {
      toast.error("폴더 이름을 입력해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const { plan } = await boardRequest<{ plan: ApplicationPlan }>(
        `/api/board/template-versions/${versionId}/apply/plan`,
        "POST",
        { targetPath },
      );
      setStep({ name: "review", plan });
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setApplying({ progress: null });
    try {
      const result = await boardStream<ApplicationResult, ApplyProgress>(
        `/api/board/template-versions/${versionId}/apply`,
        { targetPath, backup, createCollections, updates },
        (progress) => setApplying({ progress }),
      );
      setStep({ name: "done", result });
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
      setApplying(null);
    }
  }

  const overwrites =
    step.name === "review"
      ? step.plan.files.filter((file) => file.action === "overwrite")
      : [];
  const canCreateCollections =
    step.name === "review" &&
    step.plan.collections.some((c) => c.action === "create");
  const needsDatabase =
    step.name === "review" &&
    step.plan.collections.some((c) => c.action === "unavailable");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) setStep({ name: "where" });
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="lg"
          className="w-full"
          onClick={(event) => {
            if (!siteUrl) {
              event.preventDefault();
              router.push("/login");
            }
          }}
        >
          <Download aria-hidden="true" />내 사이트에 적용
        </Button>
      </DialogTrigger>

      <DialogContent
        ref={dialogRef}
        className="max-w-2xl outline-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialogRef.current?.focus();
        }}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle>내 사이트에 적용</DialogTitle>
          <DialogDescription className="truncate text-xs">
            {title} · {authorLoginName}
          </DialogDescription>
        </DialogHeader>

        {step.name === "where" && (
          <div className="space-y-5">
            {versions.length > 1 && (
              <div className="space-y-2">
                <label htmlFor="apply-version" className="text-sm font-bold">
                  버전
                </label>
                <Select
                  id="apply-version"
                  value={versionId}
                  onChange={(event) => setVersionId(event.target.value)}
                  wrapperClassName="w-full"
                >
                  {versions.map((v, index) => (
                    <option key={v.id} value={v.id}>
                      v{v.version}
                      {index === 0 ? " (최신)" : ""}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {siteCode ? (
              <div className="space-y-2">
                <p className="text-sm font-bold">어디에 적용할까요?</p>
                <div className="space-y-1 border-2 border-primary bg-primary/5 p-4">
                  <span className="block text-sm font-bold">
                    사이트 전체 (/){" "}
                    <span className="font-normal text-muted-foreground">
                      — 홈페이지가 이 템플릿으로 바뀌어요
                    </span>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    사이트 코드(_naru/)가 있는 템플릿은 사이트 맨 위에만
                    설치돼요. 사이트 코드는 사이트에 하나만 둘 수 있어요.
                  </span>
                </div>
              </div>
            ) : (
              <fieldset className="space-y-3">
                <legend id="apply-mode" className="mb-2 text-sm font-bold">
                  어디에 적용할까요?
                </legend>
                <RadioGroup
                  aria-labelledby="apply-mode"
                  value={mode}
                  onValueChange={(value) => setMode(value as "folder" | "root")}
                  className="gap-3"
                >
                  <label
                    className={`flex cursor-pointer gap-3 border-2 p-4 ${mode === "folder" ? "border-primary bg-primary/5" : "border-border"}`}
                  >
                    <RadioGroupItem value="folder" className="mt-0.5" />
                    <span className="min-w-0 flex-1 space-y-2">
                      <span className="block text-sm font-bold">
                        새 폴더에{" "}
                        <span className="font-normal text-muted-foreground">
                          — 기존 사이트는 그대로
                        </span>
                      </span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span className="truncate">{siteUrl}/</span>
                        <Input
                          aria-label="폴더 이름"
                          value={folder}
                          onChange={(event) => {
                            setFolder(event.target.value);
                            setMode("folder");
                          }}
                          className="h-9 min-w-0 flex-1 px-2 text-foreground"
                        />
                        <span>/</span>
                      </span>
                    </span>
                  </label>
                  <label
                    className={`flex cursor-pointer gap-3 border-2 p-4 ${mode === "root" ? "border-primary bg-primary/5" : "border-border"}`}
                  >
                    <RadioGroupItem value="root" className="mt-0.5" />
                    <span className="space-y-1">
                      <span className="block text-sm font-bold">
                        사이트 전체 (/){" "}
                        <span className="font-normal text-muted-foreground">
                          — 홈페이지가 이 템플릿으로 바뀌어요
                        </span>
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        겹치는 파일만 덮어쓰고, 나머지 파일은 건드리지 않아요.
                      </span>
                    </span>
                  </label>
                </RadioGroup>
              </fieldset>
            )}
            <p className="break-all border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              예: <code className="text-foreground">{samplePath}</code> →{" "}
              <code className="text-foreground">
                /{targetPrefix}
                {samplePath}
              </code>
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">취소</Button>
              </DialogClose>
              <Button onClick={review} disabled={busy}>
                {busy ? "확인하는 중…" : "바뀌는 파일 보기"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step.name === "review" && (
          <div className="space-y-5">
            {step.plan.blockers.length > 0 && (
              <div
                role="alert"
                className="space-y-1 border-2 border-destructive p-3 text-sm"
              >
                {step.plan.blockers.map((blocker) => (
                  <p key={blocker}>{blocker}</p>
                ))}
                <p className="text-xs text-muted-foreground">
                  <Link href="/templates" className="underline">
                    설치한 템플릿
                  </Link>
                  {" · "}
                  <Link href="/supporter" className="underline">
                    서포터 플랜
                  </Link>
                </p>
              </div>
            )}
            <div className="space-y-2">
              <h3 className="text-sm font-bold">바뀌는 파일</h3>
              <div className="max-h-72 overflow-y-auto border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-secondary text-left text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-normal">변경</th>
                      <th className="px-3 py-2 font-normal">경로</th>
                      <th className="px-3 py-2 text-right font-normal">크기</th>
                    </tr>
                  </thead>
                  <tbody>
                    {step.plan.files.map((file) => (
                      <tr key={file.path} className="border-t border-border">
                        <td
                          className={`whitespace-nowrap px-3 py-2 font-bold ${file.action === "overwrite" ? "text-primary" : "text-success"}`}
                        >
                          {file.action === "overwrite"
                            ? "~ 덮어씀"
                            : "+ 새 파일"}
                        </td>
                        <td className="break-all px-3 py-2">/{file.path}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">
                          {formatBytes(file.sizeBytes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {step.plan.siteCode && (
              <p className="border border-border p-3 text-sm">
                <span className="block font-bold">사이트 코드 적용</span>
                <span className="block text-xs text-muted-foreground">
                  파일을 쓴 뒤 사이트 코드를 적용해요. 마이그레이션이 있으면 그
                  전에 데이터베이스의 복원 지점을 남겨요. 나루가 사이트 코드를
                  거절하면 설치를 되돌려서, 사이트는 원래대로예요.
                </span>
              </p>
            )}

            {overwrites.length > 0 && !step.plan.siteCode && (
              <label className="flex cursor-pointer gap-3 border border-border p-3 text-sm">
                <Checkbox
                  checked={backup}
                  onCheckedChange={(checked) => setBackup(checked === true)}
                  className="mt-0.5"
                />
                <span className="space-y-1">
                  <span className="block font-bold">
                    덮어쓰기 전에 원래 파일 보관
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    덮어쓰는 파일 {overwrites.length}개를 /.backup/ 폴더에 옮겨
                    둬요. 필요하면 파일 관리에서 꺼내 쓸 수 있어요.
                  </span>
                </span>
              </label>
            )}

            {step.plan.collections.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-bold">데이터</h3>
                <label className="flex gap-3 border border-border p-3 text-sm">
                  <Checkbox
                    checked={createCollections && canCreateCollections}
                    onCheckedChange={(checked) =>
                      setCreateCollections(checked === true)
                    }
                    disabled={!canCreateCollections}
                    className="mt-0.5"
                  />
                  <span className="space-y-1">
                    <span className="block font-bold">
                      데이터베이스 컬렉션 만들기
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {step.plan.collections.map((c) => (
                        <span key={c.name} className="mr-3 inline">
                          <code className="text-foreground">
                            <CollectionName name={c.name} />
                          </code>{" "}
                          {c.action === "create"
                            ? "(새로 만듦)"
                            : c.action === "exists"
                              ? "(이미 있음)"
                              : "(데이터베이스 기능 필요)"}
                        </span>
                      ))}
                      <span className="block">
                        빈 컬렉션만 만들어요. 원작자의 데이터는 복사되지 않아요.
                      </span>
                    </span>
                  </span>
                </label>
                {needsDatabase && (
                  <p className="border border-border bg-muted p-3 text-sm">
                    이 템플릿의 일부 기능은 데이터베이스가 필요해요. 파일은
                    적용되지만, 컬렉션을 쓰는 기능은 데이터베이스 없이 동작하지
                    않아요.{" "}
                    <Link href="/supporter" className="font-bold underline">
                      서포터 플랜 알아보기
                    </Link>
                  </p>
                )}
              </div>
            )}

            <fieldset className="space-y-2">
              <legend id="apply-updates" className="mb-2 text-sm font-bold">
                새 버전이 나오면
              </legend>
              <RadioGroup
                aria-labelledby="apply-updates"
                value={updates}
                onValueChange={(value) => setUpdates(value as UpdatePreference)}
                className="gap-2"
              >
                {(
                  [
                    [
                      "notify",
                      "알려 주기",
                      "바뀌는 내용을 보고 직접 업데이트해요",
                    ],
                    [
                      "auto",
                      "자동으로 업데이트",
                      "마이그레이션이 있는 버전은 직접 업데이트해요",
                    ],
                    ["never", "받지 않기", ""],
                  ] as const
                ).map(([value, label, hint]) => (
                  <label
                    key={value}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <RadioGroupItem value={value} />
                    <span>
                      {label}
                      {hint && (
                        <span className="text-muted-foreground"> — {hint}</span>
                      )}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </fieldset>

            {applying && <ApplyProgressBar progress={applying.progress} />}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                새 파일 {step.plan.files.length - overwrites.length} · 덮어씀{" "}
                {overwrites.length}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setStep({ name: "where" })}
                  disabled={busy}
                >
                  이전
                </Button>
                <Button
                  onClick={apply}
                  disabled={busy || step.plan.blockers.length > 0}
                >
                  {busy ? "적용하는 중…" : "적용하기"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {step.name === "done" && (
          <div className="space-y-4">
            <p className="text-base font-bold">적용했어요!</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>파일 {step.result.written}개를 썼어요.</li>
              {step.result.backupPath && (
                <li>원래 파일은 /{step.result.backupPath} 에 보관했어요.</li>
              )}
              {step.result.createdCollections.length > 0 && (
                <li>
                  컬렉션 {step.result.createdCollections.join(", ")} 을(를)
                  만들었어요.
                </li>
              )}
              {step.result.skippedCollections.length > 0 && (
                <li>
                  컬렉션 {step.result.skippedCollections.join(", ")} 은(는)
                  만들지 않았어요.
                </li>
              )}
              {step.result.unavailableCollections.length > 0 && (
                <li>
                  컬렉션 {step.result.unavailableCollections.join(", ")} 은(는)
                  데이터베이스 기능이 필요해서 만들지 않았어요. 이 컬렉션을 쓰는
                  기능은 동작하지 않아요.{" "}
                  <Link
                    href="/supporter"
                    className="font-bold text-foreground underline"
                  >
                    서포터 플랜 알아보기
                  </Link>
                </li>
              )}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <a
                  href={`${siteUrl}/${step.result.targetPath}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  내 사이트에서 보기 ↗
                </a>
              </Button>
              <DialogClose asChild>
                <Button variant="outline">닫기</Button>
              </DialogClose>
            </div>
            <p className="text-xs text-muted-foreground">
              새 버전이 나오면{" "}
              <Link href="/templates" className="underline">
                설치한 템플릿
              </Link>
              에서 업데이트할 수 있어요. 직접 고친 파일은 업데이트할 때 보관해
              둬요.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
