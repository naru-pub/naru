"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { TemplateSource } from "@/lib/board/constants";
import { boardRequest } from "../../_components/api";

// Where a template's new versions come from: snapshots of the author's site
// folder, or a GitHub Actions workflow that publishes its build.
export function SourceForm({
  templateId,
  source,
  repository,
  branch,
}: {
  templateId: string;
  source: TemplateSource;
  repository: string;
  branch: string;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<TemplateSource>(source);
  const [repo, setRepo] = useState(repository);
  const [ref, setRef] = useState(branch || "main");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await boardRequest(`/api/board/templates/${templateId}/source`, "PUT", {
        source: chosen,
        githubRepository: repo,
        githubRef: ref,
      });
      toast.success("저장했어요.");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <RadioGroup
        aria-label="새 버전을 올리는 곳"
        value={chosen}
        onValueChange={(value) => setChosen(value as TemplateSource)}
        className="gap-3"
      >
        <label
          className={`flex cursor-pointer gap-3 border-2 p-4 ${chosen === "site" ? "border-primary bg-primary/5" : "border-border"}`}
        >
          <RadioGroupItem value="site" className="mt-0.5" />
          <span className="space-y-1">
            <span className="block text-sm font-bold">내 사이트 폴더에서</span>
            <span className="block text-xs text-muted-foreground">
              「새 버전 올리기」를 누를 때 고른 파일을 찍어 둬요.
            </span>
          </span>
        </label>
        <label
          className={`flex cursor-pointer gap-3 border-2 p-4 ${chosen === "github" ? "border-primary bg-primary/5" : "border-border"}`}
        >
          <RadioGroupItem value="github" className="mt-0.5" />
          <span className="min-w-0 flex-1 space-y-3">
            <span className="block space-y-1">
              <span className="block text-sm font-bold">
                GitHub Actions에서
              </span>
              <span className="block text-xs text-muted-foreground">
                저장소의 워크플로가 빌드한 결과를 버전으로 올려요. 사이트 배포와
                같은 방식이에요. 서포터 플랜에서 쓸 수 있어요.
              </span>
            </span>
            <span className="grid gap-3 sm:grid-cols-2">
              <span className="space-y-1">
                <label htmlFor="source-repo" className="block text-xs">
                  저장소
                </label>
                <Input
                  id="source-repo"
                  value={repo}
                  placeholder="owner/name"
                  onChange={(event) => {
                    setRepo(event.target.value);
                    setChosen("github");
                  }}
                  className="font-mono"
                />
              </span>
              <span className="space-y-1">
                <label htmlFor="source-ref" className="block text-xs">
                  브랜치
                </label>
                <Input
                  id="source-ref"
                  value={ref}
                  onChange={(event) => {
                    setRef(event.target.value);
                    setChosen("github");
                  }}
                  className="font-mono"
                />
              </span>
            </span>
          </span>
        </label>
      </RadioGroup>

      {chosen === "github" && (
        <div className="space-y-2 text-xs">
          <p className="text-muted-foreground">
            워크플로에서 빌드한 폴더를 이 템플릿의 새 버전으로 올려요. 커밋
            메시지가 버전 설명이 돼요.
          </p>
          <pre className="overflow-x-auto border border-border bg-secondary p-3 font-mono leading-relaxed">
            {`permissions:
  id-token: write
steps:
  - run: pnpm install --frozen-lockfile && pnpm build
  - uses: naru-pub/naru/actions/deploy@main
    with:
      dir: dist
      template: ${templateId}`}
          </pre>
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy ? "저장하는 중…" : "저장"}
        </Button>
      </div>
    </form>
  );
}
