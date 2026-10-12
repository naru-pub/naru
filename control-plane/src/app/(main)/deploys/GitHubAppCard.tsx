"use client";

import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Github, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";

// Connecting a repository through Naru's GitHub App: install the App (or sign
// in to GitHub, when it is installed already), pick a repository, and every
// push to its branch is published. No workflow file and no repository
// settings. Repositories built by a workflow keep the Actions card below.

export type AppTarget = {
  id: string;
  githubRepository: string;
  branch: string;
  sourceDir: string;
  targetPrefix: string;
  pending: boolean;
  lastError: string | null;
  lastGithubSha: string | null;
  lastDeployedAt: string | null;
  skippedCount: number;
};

type Repository = {
  id: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
};
type Installation = {
  installationId: string;
  accountLogin: string;
  repositories: Repository[] | null;
};

const NOTICES: Record<string, [string, boolean]> = {
  connected: ["GitHub와 연결했습니다. 배포할 저장소를 고르세요.", true],
  expired: ["GitHub 연결이 만료되었습니다. 다시 시도해 주세요.", false],
  failed: ["GitHub와 연결하지 못했습니다. 다시 시도해 주세요.", false],
  unavailable: ["지금은 GitHub 연결을 쓸 수 없습니다.", false],
};

const folder = (value: string) => (value ? `/${value}/` : "/");

export default function GitHubAppCard({
  loginName,
  targets,
  notice,
}: {
  loginName: string;
  targets: AppTarget[];
  notice: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [installations, setInstallations] = useState<Installation[] | null>(
    null,
  );
  const [configured, setConfigured] = useState(true);
  const [choice, setChoice] = useState("");
  const [branch, setBranch] = useState("");
  const [sourceDir, setSourceDir] = useState("/");
  const [targetPrefix, setTargetPrefix] = useState("/");
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const shown = notice && NOTICES[notice];
    if (shown) (shown[1] ? toast.success : toast.error)(shown[0]);
  }, [notice]);

  useEffect(() => {
    fetch("/api/account/github-app")
      .then((response) => response.json())
      .then((result) => {
        if (result.configured === false) setConfigured(false);
        else if (result.success) setInstallations(result.installations);
        else toast.error(result.message ?? "GitHub 저장소를 읽지 못했습니다.");
      })
      .catch(() => toast.error("GitHub 저장소를 읽지 못했습니다."));
  }, []);

  // While a deploy is waiting or running, its row is refreshed every few
  // seconds until it finishes.
  const working = targets.some((target) => target.pending);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [working, router]);

  const repositories = useMemo(
    () =>
      (installations ?? []).flatMap((installation) =>
        (installation.repositories ?? []).map((repository) => ({
          ...repository,
          installationId: installation.installationId,
        })),
      ),
    [installations],
  );
  const chosen = repositories.find(
    (repository) => `${repository.installationId}:${repository.id}` === choice,
  );

  async function send(method: string, url: string, body: object, id: string) {
    setBusy(id);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!result.success) {
        toast.error(result.message ?? "하지 못했습니다.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      toast.error("나루에 연결하지 못했습니다.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen) return;
    const done = await send(
      "POST",
      "/api/account/github-app",
      {
        installationId: chosen.installationId,
        repositoryId: chosen.id,
        branch: branch || chosen.defaultBranch,
        sourceDir,
        targetPrefix,
      },
      "new",
    );
    if (done) {
      toast.success(`${chosen.fullName}을(를) 연결했습니다. 곧 배포됩니다.`);
      setChoice("");
      setAdding(false);
    }
  }

  // Once a repository is connected, connecting another is tucked away; with
  // one deploying to the site root there is no folder left that wouldn't
  // overlap it, so there is nothing to offer.
  const rootTaken = targets.some((target) => target.targetPrefix === "");
  const showConnect = targets.length === 0 || (adding && !rootTaken);

  if (!configured) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Github size={20} />
          GitHub 저장소 연결
        </CardTitle>
        <p className="text-muted-foreground text-sm">
          GitHub 저장소를 연결하면, 푸시할 때마다 그 내용이{" "}
          <strong>{loginName}.naru.pub</strong>에 배포됩니다. 워크플로 파일이나
          저장소 설정은 필요 없습니다.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {targets.length > 0 && (
          <ul className="divide-y rounded-md border">
            {targets.map((target) => (
              <li key={target.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{target.githubRepository}</strong>
                  <Badge variant="secondary">{target.branch}</Badge>
                  <span className="text-muted-foreground text-sm">
                    {folder(target.sourceDir)} → {loginName}.naru.pub
                    {folder(target.targetPrefix)}
                  </span>
                </div>
                <p className="text-sm">
                  {target.pending ? (
                    <Badge>배포 중</Badge>
                  ) : target.lastError ? (
                    <span className="text-destructive">
                      배포하지 못했습니다: {target.lastError}
                    </span>
                  ) : target.lastDeployedAt ? (
                    <span className="text-muted-foreground">
                      {new Date(target.lastDeployedAt).toLocaleString("ko-KR")}
                      에 {target.lastGithubSha?.slice(0, 7)}을(를) 배포했습니다.
                      {target.skippedCount > 0 &&
                        ` 배포하지 않은 파일 ${target.skippedCount}개.`}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      아직 배포하지 않았습니다.
                    </span>
                  )}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === target.id || target.pending}
                    onClick={() =>
                      send(
                        "PUT",
                        "/api/account/github-app",
                        { id: target.id },
                        target.id,
                      )
                    }
                  >
                    <RefreshCw size={14} /> 지금 배포
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === target.id}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `${target.githubRepository} 연결을 끊을까요? 이미 배포된 파일은 그대로 남습니다.`,
                          confirmText: "연결 끊기",
                          destructive: true,
                        })
                      )
                        await send(
                          "DELETE",
                          "/api/account/github-deploy-targets",
                          { id: target.id },
                          target.id,
                        );
                    }}
                  >
                    <Trash2 size={14} /> 연결 끊기
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {showConnect ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              {/* Route handlers that send the browser on to GitHub: a full page
                navigation, which a client-side Link would not make. */}
              <Button asChild>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href="/api/github/install">GitHub 연결하기</a>
              </Button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a className="text-sm underline" href="/api/github/connect">
                이미 설치했다면 GitHub 계정 다시 확인
              </a>
            </div>

            {installations === null ? (
              <p className="text-muted-foreground text-sm">
                연결한 저장소를 읽는 중…
              </p>
            ) : repositories.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                연결할 수 있는 저장소가 없습니다. ‘GitHub 연결하기’에서 나루가
                읽을 저장소를 고르세요.
              </p>
            ) : (
              <form className="grid gap-3 sm:grid-cols-2" onSubmit={connect}>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="github-app-repository">저장소</Label>
                  <Select
                    id="github-app-repository"
                    className="w-full"
                    value={choice}
                    onChange={(event) => {
                      setChoice(event.target.value);
                      setBranch("");
                    }}
                    required
                  >
                    <option value="">고르세요</option>
                    {repositories.map((repository) => (
                      <option
                        key={`${repository.installationId}:${repository.id}`}
                        value={`${repository.installationId}:${repository.id}`}
                      >
                        {repository.fullName}
                        {repository.private ? " (비공개)" : ""}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="github-app-branch">브랜치</Label>
                  <Input
                    id="github-app-branch"
                    value={branch}
                    placeholder={chosen?.defaultBranch ?? "main"}
                    onChange={(event) => setBranch(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="github-app-source">
                    저장소에서 배포할 폴더
                  </Label>
                  <Input
                    id="github-app-source"
                    value={sourceDir}
                    onChange={(event) => setSourceDir(event.target.value)}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="github-app-prefix">사이트에 놓을 폴더</Label>
                  <Input
                    id="github-app-prefix"
                    value={targetPrefix}
                    onChange={(event) => setTargetPrefix(event.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    이 폴더에 있던 파일 가운데 저장소에 없는 것은 배포할 때
                    지워집니다. 점(.)으로 시작하는 파일과 폴더, node_modules,
                    나루가 올릴 수 없는 형식의 파일은 배포하지 않습니다.
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={!chosen || busy === "new"}>
                    연결하고 배포하기
                  </Button>
                </div>
              </form>
            )}
          </>
        ) : (
          !rootTaken && (
            <Button variant="outline" onClick={() => setAdding(true)}>
              다른 저장소 연결하기
            </Button>
          )
        )}
      </CardContent>
    </Card>
  );
}
