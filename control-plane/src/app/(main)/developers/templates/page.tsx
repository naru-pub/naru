import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { LICENSES } from "@/lib/board/constants";
import {
  publishedTemplates,
  templateDashboard,
  type WorkflowRun,
} from "@/lib/board/template-dashboard";
import { parseUuid } from "@/lib/uuid";
import { formatDate, formatRelative } from "../../board/_components/format";

export const metadata: Metadata = { title: "내 템플릿 | 나루" };

const PANEL = "border-2 border-line bg-card";
const PANEL_HEADING =
  "border-b-2 border-line bg-muted px-5 py-3.5 text-lg font-bold";
const LINK = "font-bold text-link underline-offset-4 hover:underline";
const BUTTON =
  "inline-flex min-h-11 items-center border-2 border-line px-4 font-bold";
const CELL = "border-b border-border px-5 py-3 align-top";

const RUN_BADGES: Record<
  WorkflowRun["outcome"],
  { label: string; tone: string }
> = {
  published: { label: "게시됨", tone: "border-success text-success" },
  unchanged: { label: "건너뜀", tone: "border-border text-muted-foreground" },
  planned: { label: "올리는 중", tone: "border-link text-link" },
  failed: { label: "실패", tone: "border-destructive text-destructive" },
  expired: { label: "만료", tone: "border-border text-muted-foreground" },
};

const shortSha = (sha: string) => sha.slice(0, 7);

// A version's new migrations, by name: all of a few, or the first and last.
function migrationSummary(paths: string[]): string | null {
  const names = paths.map((path) => path.split("/").pop()!);
  if (names.length === 0) return null;
  if (names.length <= 2) return names.join(", ");
  return `${names[0]} … ${names[names.length - 1]} (${names.length}개)`;
}

// The signed-in person's published templates: the GitHub
// workflow's runs, and versions with the tables their site code makes.
export default async function DeveloperTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  const { user } = await validateRequest();
  if (!user) redirect("/login");
  const templates = await publishedTemplates(user.id);
  const { template } = await searchParams;
  const selected =
    template === undefined
      ? (templates[0]?.postId ?? null)
      : parseUuid(template);
  if (template !== undefined && !selected) notFound();
  const dashboard = selected
    ? await templateDashboard(user.id, selected)
    : null;
  if (selected && !dashboard) notFound();

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 pb-16 pt-10 sm:px-6 lg:px-8">
        <section className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="flex flex-col gap-2">
            <p className="font-mono text-sm text-muted-foreground">
              <Link href="/developers" className="hover:underline">
                NARU / DEVELOPERS
              </Link>{" "}
              / TEMPLATES
            </p>
            <h1 className="text-3xl font-bold tracking-tight">내 템플릿</h1>
            <p className="text-muted-foreground">
              공개한 템플릿의 워크플로와 버전을 봐요.
            </p>
          </div>
          <Link
            href="/board/new?kind=template"
            className={`${BUTTON} press bg-primary text-primary-foreground`}
          >
            새 템플릿 공개하기
          </Link>
        </section>

        {!dashboard ? (
          <p className={`${PANEL} p-6 text-muted-foreground`}>
            아직 공개한 템플릿이 없어요. 내 사이트의 폴더나 GitHub 저장소를
            템플릿으로 나눌 수 있어요.
          </p>
        ) : (
          <>
            {templates.length > 1 && (
              <nav aria-label="템플릿 고르기" className="flex flex-wrap gap-2">
                {templates.map((template) => {
                  const current = template.postId === dashboard.postId;
                  return (
                    <Link
                      key={template.postId}
                      href={`/developers/templates?template=${template.postId}`}
                      aria-current={current ? "page" : undefined}
                      className={`${BUTTON} ${
                        current
                          ? "bg-foreground text-background"
                          : "bg-card font-normal hover:bg-accent"
                      }`}
                    >
                      {template.title}
                    </Link>
                  );
                })}
              </nav>
            )}
            <Dashboard dashboard={dashboard} loginName={user.loginName} />
          </>
        )}
      </div>
    </div>
  );
}

function Dashboard({
  dashboard,
  loginName,
}: {
  dashboard: NonNullable<Awaited<ReturnType<typeof templateDashboard>>>;
  loginName: string;
}) {
  const { template } = dashboard;
  const latest = template.versions[0] ?? null;
  const githubUrl = template.github
    ? `https://github.com/${template.github.repository}`
    : null;

  return (
    <>
      <section aria-labelledby="template-h" className={PANEL}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 p-5">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="template-h" className="text-2xl font-bold">
              {dashboard.title}
            </h2>
            <span className="break-all font-mono text-sm text-muted-foreground">
              {loginName}/{template.slug} · {LICENSES[template.license].name}
              {latest?.siteCode && " · 사이트 코드"}
              {template.source === "github" ? " · GitHub" : " · 사이트 폴더"}
            </span>
          </div>
          <Link
            href={`/board/${dashboard.postId}`}
            className={`${LINK} text-sm`}
          >
            게시글 보기 →
          </Link>
        </div>
      </section>

      {template.source === "github" && (
        <section aria-labelledby="workflow-h" className={PANEL}>
          <h2 id="workflow-h" className={PANEL_HEADING}>
            GitHub 워크플로
          </h2>
          <div className="flex flex-col gap-4 p-5">
            {template.github && (
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">저장소</dt>
                <dd className="break-all font-mono">
                  <a href={githubUrl!} className={LINK}>
                    {template.github.repository}
                  </a>
                </dd>
                <dt className="text-muted-foreground">브랜치</dt>
                <dd className="break-all font-mono">
                  {template.github.ref.replace(/^refs\/heads\//, "")}
                </dd>
                <dt className="text-muted-foreground">폴더</dt>
                <dd className="break-all font-mono">
                  /{template.github.path ?? ""}
                </dd>
              </dl>
            )}
            {dashboard.runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                아직 워크플로가 올린 적이 없어요.{" "}
                <a href="https://github.com/naru-pub/actions" className={LINK}>
                  naru-pub/actions
                </a>
                로 push할 때 새 버전을 올려요.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-bold">최근 실행</h3>
                <ol className="flex flex-col text-sm">
                  {dashboard.runs.map((run) => (
                    <RunRow key={run.id} run={run} githubUrl={githubUrl} />
                  ))}
                </ol>
              </div>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="versions-h" className={PANEL}>
        <h2 id="versions-h" className={PANEL_HEADING}>
          버전
        </h2>
        {template.versions.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            아직 버전이 없어요.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-background text-left text-muted-foreground">
                  {["버전", "언제", "커밋", "새 마이그레이션", "테이블"].map(
                    (heading) => (
                      <th
                        key={heading}
                        scope="col"
                        className="whitespace-nowrap border-b border-border px-5 py-2.5 font-semibold"
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {template.versions.map((version, index) => {
                  const migrations = migrationSummary(version.newMigrations);
                  return (
                    <tr key={version.id}>
                      <td className={`${CELL} whitespace-nowrap font-bold`}>
                        v{version.version}
                        {index === 0 && (
                          <span className="ml-2 border border-link px-1.5 text-xs font-normal text-link">
                            최신
                          </span>
                        )}
                      </td>
                      <td
                        className={`${CELL} whitespace-nowrap text-muted-foreground`}
                      >
                        {formatDate(version.createdAt)}
                      </td>
                      <td className={`${CELL} font-mono`}>
                        {version.githubSha && githubUrl ? (
                          <a
                            href={`${githubUrl}/commit/${version.githubSha}`}
                            className={LINK}
                          >
                            {shortSha(version.githubSha)}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td
                        className={`${CELL} ${migrations ? "font-mono" : "text-muted-foreground"}`}
                      >
                        {migrations ?? "없음"}
                      </td>
                      <td className={CELL}>
                        <Tables
                          siteCode={version.siteCode}
                          tables={version.tables}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function RunRow({
  run,
  githubUrl,
}: {
  run: WorkflowRun;
  githubUrl: string | null;
}) {
  const badge = RUN_BADGES[run.outcome];
  return (
    <li className="flex flex-col gap-1 border-b border-border py-2.5 first:pt-0 last:border-b-0 last:pb-0">
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`border px-2 text-xs font-bold ${badge.tone}`}>
          {badge.label}
        </span>
        {run.outcome === "published" && run.version !== null && (
          <span className="font-bold">v{run.version}</span>
        )}
        {githubUrl ? (
          <a
            href={`${githubUrl}/commit/${run.sha}`}
            className={`${LINK} font-mono`}
          >
            {shortSha(run.sha)}
          </a>
        ) : (
          <span className="font-mono">{shortSha(run.sha)}</span>
        )}
        <span className="text-muted-foreground">
          {formatRelative(run.createdAt)}
        </span>
      </span>
      {run.outcome === "unchanged" && (
        <span className="text-muted-foreground">
          v{run.version}와 파일이 같아서 새 버전을 만들지 않았어요.
        </span>
      )}
      {run.outcome === "expired" && (
        <span className="text-muted-foreground">
          파일을 다 올리기 전에 시간이 지났어요.
        </span>
      )}
      {run.outcome === "failed" && run.error && (
        <span className="break-words font-mono text-xs text-destructive">
          {run.error}
        </span>
      )}
    </li>
  );
}

function Tables({
  siteCode,
  tables,
}: {
  siteCode: boolean;
  tables: string[] | null;
}) {
  if (!siteCode) return <span className="text-muted-foreground">—</span>;
  // Recorded when its migrations are tried on the edge.
  if (tables === null)
    return <span className="text-muted-foreground">확인 전</span>;
  if (tables.length === 0) return <span>0</span>;
  return (
    <details>
      <summary className="cursor-pointer whitespace-nowrap">
        {tables.length}개
      </summary>
      <ul className="mt-1.5 flex max-w-xs flex-wrap gap-x-2 gap-y-0.5 font-mono text-xs text-muted-foreground">
        {tables.map((table) => (
          <li key={table}>{table}</li>
        ))}
      </ul>
    </details>
  );
}
