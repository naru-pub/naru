import { History } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  displayRef,
  normalizeWorkflowTargetPrefix,
} from "@/lib/deploy/githubWorkflow";

// Deployments from both ways of deploying from GitHub: repositories connected
// through the App and those deployed by an Actions workflow.

export type GitHubDeployment = {
  id: string;
  status: string;
  githubRepository: string;
  githubRef: string;
  githubSha: string;
  targetPrefix: string;
  fileCount: number;
  uploadedFileCount: number;
  deletedFileCount: number;
  errorMessage: string | null;
  createdAt: string;
  finalizedAt: string | null;
};

function statusLabel(status: string) {
  if (status === "finalized") return "성공";
  if (status === "failed") return "실패";
  if (status === "expired") return "만료";
  return "진행 중";
}

export default function GitHubDeploymentsCard({
  deployments,
}: {
  deployments: GitHubDeployment[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History size={20} />
          최근 배포
        </CardTitle>
        <p className="text-muted-foreground text-sm">
          최근 20개의 GitHub 배포 시도와 오류를 확인할 수 있습니다.
        </p>
      </CardHeader>
      <CardContent>
        {deployments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            아직 기록된 배포가 없습니다.
          </p>
        ) : (
          <div className="divide-y divide-border rounded border border-border">
            {deployments.map((deployment) => (
              <div key={deployment.id} className="space-y-2 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <Badge
                      variant={
                        deployment.status === "failed" ||
                        deployment.status === "expired"
                          ? "destructive"
                          : deployment.status === "finalized"
                            ? "default"
                            : "secondary"
                      }
                    >
                      {statusLabel(deployment.status)}
                    </Badge>
                    <span className="font-medium break-all">
                      {deployment.githubRepository}
                    </span>
                    <code title={deployment.githubSha}>
                      {deployment.githubSha.slice(0, 7)}
                    </code>
                  </div>
                  <time
                    className="text-muted-foreground"
                    dateTime={deployment.createdAt}
                  >
                    {new Date(deployment.createdAt).toLocaleString()}
                  </time>
                </div>
                <p className="text-muted-foreground">
                  {displayRef(deployment.githubRef)} →{" "}
                  {normalizeWorkflowTargetPrefix(deployment.targetPrefix)} ·{" "}
                  {deployment.fileCount}개 파일
                  {deployment.uploadedFileCount < deployment.fileCount
                    ? ` · ${deployment.uploadedFileCount}개 변경`
                    : ""}
                  {deployment.deletedFileCount > 0
                    ? ` · ${deployment.deletedFileCount}개 삭제`
                    : ""}
                </p>
                {deployment.errorMessage ? (
                  <p className="rounded bg-destructive/10 px-2 py-1 text-destructive break-words">
                    {deployment.errorMessage}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
