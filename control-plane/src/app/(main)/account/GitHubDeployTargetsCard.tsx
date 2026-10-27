"use client";

import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { CheckCircle2, Copy, Github, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  displayRef,
  githubWorkflowYaml,
  normalizeWorkflowTargetPrefix,
} from "@/lib/deploy/githubWorkflow";

type GitHubDeployTarget = {
  id: string;
  githubRepository: string;
  githubRef: string;
  targetPrefix: string;
  enabled: boolean;
  lastGithubSha: string | null;
  lastDeployedAt: string | null;
};

function refFromBranch(branch: string) {
  const trimmed = branch.trim();
  if (trimmed.startsWith("refs/heads/") || trimmed.startsWith("refs/tags/")) {
    return trimmed;
  }
  return `refs/heads/${trimmed || "main"}`;
}

// A tag keeps its full ref, which refFromBranch passes through.
function branchFromRef(ref: string) {
  return ref.startsWith("refs/heads/") ? displayRef(ref) : ref;
}

type TargetFields = {
  githubRepository: string;
  branch: string;
  targetPrefix: string;
};

export default function GitHubDeployTargetsCard({
  loginName,
  targets,
}: {
  loginName: string;
  targets: GitHubDeployTarget[];
}) {
  const [githubRepository, setGithubRepository] = useState("");
  const [branch, setBranch] = useState("main");
  const [targetPrefix, setTargetPrefix] = useState("/");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<TargetFields>({
    githubRepository: "",
    branch: "",
    targetPrefix: "",
  });

  const sortedTargets = useMemo(
    () => targets.filter((target) => target.enabled),
    [targets],
  );

  async function addTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingId("new");

    try {
      const response = await fetch("/api/account/github-deploy-targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          githubRepository,
          githubRef: refFromBranch(branch),
          targetPrefix,
        }),
      });
      const result = await response.json();

      if (result.success) {
        toast.success("GitHub 배포 대상이 저장되었습니다.");
        setGithubRepository("");
        setBranch("main");
        setTargetPrefix("/");
        window.location.reload();
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("GitHub 배포 대상 저장 중 오류가 발생했습니다.");
    } finally {
      setPendingId(null);
    }
  }

  function startEditing(target: GitHubDeployTarget) {
    setEditingId(target.id);
    setEditFields({
      githubRepository: target.githubRepository,
      branch: branchFromRef(target.githubRef),
      targetPrefix: normalizeWorkflowTargetPrefix(target.targetPrefix),
    });
  }

  async function updateTarget(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    setPendingId(id);

    try {
      const response = await fetch("/api/account/github-deploy-targets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          githubRepository: editFields.githubRepository,
          githubRef: refFromBranch(editFields.branch),
          targetPrefix: editFields.targetPrefix,
        }),
      });
      const result = await response.json();

      if (result.success) {
        toast.success("GitHub 배포 대상이 수정되었습니다.");
        window.location.reload();
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("GitHub 배포 대상 수정 중 오류가 발생했습니다.");
    } finally {
      setPendingId(null);
    }
  }

  async function deleteTarget(id: string) {
    setPendingId(id);

    try {
      const response = await fetch("/api/account/github-deploy-targets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const result = await response.json();

      if (result.success) {
        toast.success("GitHub 배포 대상이 삭제되었습니다.");
        window.location.reload();
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("GitHub 배포 대상 삭제 중 오류가 발생했습니다.");
    } finally {
      setPendingId(null);
    }
  }

  async function copyWorkflow(target: GitHubDeployTarget) {
    await navigator.clipboard.writeText(githubWorkflowYaml(loginName, target));
    toast.success("워크플로를 복사했습니다.");
  }

  return (
    <Card className="bg-card border-2 border-line">
      <CardHeader className="border-b border-border">
        <CardTitle className="text-foreground text-xl font-bold flex items-center gap-2">
          <Github size={20} />
          GitHub 배포
        </CardTitle>
      </CardHeader>
      <CardContent className="p-6 space-y-4">
        <div className="bg-muted border border-border rounded p-3 text-sm text-muted-foreground space-y-2">
          <p>GitHub Actions에서 빌드한 파일을 나루로 배포할 수 있습니다.</p>
          <p>
            저장소와 브랜치를 등록하면 해당 워크플로만 이 계정에 배포할 수
            있습니다.
          </p>
        </div>

        <form onSubmit={addTarget} className="grid gap-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_160px_140px_auto] sm:items-end">
            <div className="space-y-1">
              <Label htmlFor="github-repository">저장소</Label>
              <Input
                id="github-repository"
                value={githubRepository}
                onChange={(event) => setGithubRepository(event.target.value)}
                placeholder="owner/repo"
                disabled={pendingId !== null}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="github-branch">브랜치</Label>
              <Input
                id="github-branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
                disabled={pendingId !== null}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="github-target-prefix">대상</Label>
              <Input
                id="github-target-prefix"
                value={targetPrefix}
                onChange={(event) => setTargetPrefix(event.target.value)}
                placeholder="/"
                disabled={pendingId !== null}
              />
            </div>
            <Button
              type="submit"
              disabled={pendingId !== null || githubRepository.trim() === ""}
              className="flex items-center gap-2"
            >
              <Plus size={16} />
              추가
            </Button>
          </div>
        </form>

        <div className="space-y-3">
          {sortedTargets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              등록된 GitHub 배포 대상이 없습니다.
            </p>
          ) : (
            sortedTargets.map((target) => {
              const yaml = githubWorkflowYaml(loginName, target);

              return (
                <div
                  key={target.id}
                  className="border border-border rounded p-3 space-y-3"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-foreground break-all">
                          {target.githubRepository}
                        </p>
                        <Badge variant="secondary">
                          {displayRef(target.githubRef)}
                        </Badge>
                        <Badge variant="outline">
                          {normalizeWorkflowTargetPrefix(target.targetPrefix)}
                        </Badge>
                      </div>
                      {target.lastDeployedAt ? (
                        <p className="text-sm text-muted-foreground flex items-center gap-1">
                          <CheckCircle2 size={14} />
                          마지막 배포:{" "}
                          {new Date(target.lastDeployedAt).toLocaleString("ko-KR", {
                            timeZone: "Asia/Seoul",
                          })}
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          아직 배포된 적이 없습니다.
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => startEditing(target)}
                        disabled={pendingId !== null || editingId === target.id}
                        className="flex items-center gap-2"
                      >
                        <Pencil size={14} />
                        수정
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => copyWorkflow(target)}
                        disabled={pendingId !== null}
                        className="flex items-center gap-2"
                      >
                        <Copy size={14} />
                        복사
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => deleteTarget(target.id)}
                        disabled={pendingId !== null}
                        className="flex items-center gap-2"
                      >
                        <Trash2 size={14} />
                        삭제
                      </Button>
                    </div>
                  </div>

                  {editingId === target.id && (
                    <form
                      onSubmit={(event) => updateTarget(event, target.id)}
                      className="space-y-2"
                    >
                      <div className="grid gap-2 sm:grid-cols-[1fr_160px_140px] sm:items-end">
                        <div className="space-y-1">
                          <Label htmlFor={`github-repository-${target.id}`}>
                            저장소
                          </Label>
                          <Input
                            id={`github-repository-${target.id}`}
                            value={editFields.githubRepository}
                            onChange={(event) =>
                              setEditFields({
                                ...editFields,
                                githubRepository: event.target.value,
                              })
                            }
                            placeholder="owner/repo"
                            disabled={pendingId !== null}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`github-branch-${target.id}`}>
                            브랜치
                          </Label>
                          <Input
                            id={`github-branch-${target.id}`}
                            value={editFields.branch}
                            onChange={(event) =>
                              setEditFields({
                                ...editFields,
                                branch: event.target.value,
                              })
                            }
                            placeholder="main"
                            disabled={pendingId !== null}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`github-target-prefix-${target.id}`}>
                            대상
                          </Label>
                          <Input
                            id={`github-target-prefix-${target.id}`}
                            value={editFields.targetPrefix}
                            onChange={(event) =>
                              setEditFields({
                                ...editFields,
                                targetPrefix: event.target.value,
                              })
                            }
                            placeholder="/"
                            disabled={pendingId !== null}
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        대상 폴더를 바꾸면 이전 폴더에 배포된 파일은 그대로
                        남습니다. 저장한 뒤 워크플로를 다시 복사해 저장소에
                        반영하세요.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          type="submit"
                          size="sm"
                          disabled={
                            pendingId !== null ||
                            editFields.githubRepository.trim() === ""
                          }
                        >
                          저장
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setEditingId(null)}
                          disabled={pendingId !== null}
                        >
                          취소
                        </Button>
                      </div>
                    </form>
                  )}

                  <pre className="bg-background border border-border rounded p-3 text-xs overflow-x-auto whitespace-pre">
                    {yaml}
                  </pre>
                </div>
              );
            })
          )}
        </div>

      </CardContent>
    </Card>
  );
}
