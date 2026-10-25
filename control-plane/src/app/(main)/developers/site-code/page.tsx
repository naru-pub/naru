import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { sql } from "kysely";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { getHomepageUrl } from "@/lib/site-urls";
import { FunctionRevisions } from "@/lib/site-functions/revisions";
import { runtimeStorage, siteStorage } from "@/lib/site-functions/storage";
import { DatabaseAndUsage, Problems, type RefusedRelease } from "./Status";

export const metadata: Metadata = {
  title: "내 사이트 코드 | 나루",
};

/** How long a refused release stays in 문제: as long as paused statements. */
const PROBLEM_DAYS = 7;

const when = (date: Date) =>
  date.toLocaleString("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  });
const short = (revision: string) => revision.slice(0, 12);

const PANEL = "border-2 border-line bg-card";
const LINK = "font-bold text-link underline-offset-4 hover:underline";
const BUTTON =
  "inline-flex min-h-11 items-center border-2 border-line px-5 font-bold";
const SECTIONS = [
  ["overview", "개요"],
  ["problems", "문제"],
  ["releases", "릴리스"],
  ["database", "데이터베이스"],
  ["usage", "사용량"],
];

/** A release's files by kind, or null when its manifest can't be read. */
async function filesOf(site: string, revision: string) {
  try {
    const files = await new FunctionRevisions(
      siteStorage,
      runtimeStorage,
      site,
    ).filenames(revision);
    const under = (folder: string) =>
      files.filter((file) => file.startsWith(`${folder}/`));
    return {
      migrations: under("migrations").map((file) =>
        file.slice("migrations/".length),
      ),
      queries: under("queries").length,
      mutations: under("mutations").length,
      routes: files.includes("routes.json"),
    };
  } catch (error) {
    console.error("Reading a release's files failed", error);
    return null;
  }
}

/**
 * The owner's site code (SDK 1.1.0, `_naru/`) at a glance: its release, what
 * went wrong lately, its database and usage. Only what Naru records: the
 * releases in site_function_releases (the active one and those still being
 * activated or retired), refused GitHub deploys, and, from the routes
 * /database reads, paused statements, tables, restore points and usage.
 */
export default async function SiteCodePage() {
  const { user } = await validateRequest();
  if (!user) redirect("/supporter");
  if (!(await userHasFeature(user.id, "database"))) redirect("/supporter");
  const site = user.loginName;

  const [releases, refusals] = await Promise.all([
    db
      .selectFrom("site_function_releases as release")
      .leftJoin(
        "github_deployments as deployment",
        "deployment.functions_release_id",
        "release.id",
      )
      .select([
        "release.id",
        "release.revision",
        "release.created_at",
        "deployment.github_repository",
        "deployment.github_sha",
        "deployment.functions_status",
      ])
      .where("release.user_id", "=", user.id)
      .orderBy("release.id", "desc")
      .execute(),
    db
      .selectFrom("github_deployments")
      .select([
        "id",
        "created_at",
        "github_repository",
        "github_sha",
        "functions_error",
      ])
      .where("user_id", "=", user.id)
      .where("functions_status", "=", "refused")
      .where(
        "created_at",
        ">",
        sql<Date>`now() - ${PROBLEM_DAYS} * interval '1 day'`,
      )
      .orderBy("created_at", "desc")
      .limit(20)
      .execute(),
  ]);
  // A deploy's release is active once its task says so; one still
  // activating, or refused, leaves the one before it serving.
  const current =
    releases.find(
      (release) =>
        release.functions_status !== "activating" &&
        release.functions_status !== "refused",
    ) ?? null;
  const files = current ? await filesOf(site, current.revision) : null;
  // A refused deploy is listed from github_deployments below, which keeps it
  // after its release row is deleted.
  const listed = releases.filter(
    (release) => release.functions_status !== "refused",
  );
  const refused: RefusedRelease[] = refusals.map((deployment) => ({
    id: deployment.id,
    at: deployment.created_at.getTime(),
    where: `${deployment.github_repository}@${deployment.github_sha.slice(0, 7)}`,
    message: deployment.functions_error?.message ?? null,
  }));

  const source = (repository: string | null, sha: string | null) =>
    repository && sha ? (
      <>
        {" · GitHub "}
        <a
          href={`https://github.com/${repository}/commit/${sha}`}
          className={`${LINK} font-mono font-normal`}
        >
          {repository}@{sha.slice(0, 7)}
        </a>
      </>
    ) : null;

  return (
    <div className="min-h-screen">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 pb-16 pt-10 sm:px-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:px-8">
        <nav
          aria-label="사이트 코드"
          className="-mx-4 flex gap-1 overflow-x-auto border-b-2 border-line px-4 pb-2 lg:sticky lg:top-6 lg:mx-0 lg:flex-col lg:self-start lg:border-b-0 lg:px-0"
        >
          <Link
            href="/developers"
            className="shrink-0 px-3 py-2 text-sm text-muted-foreground hover:bg-accent lg:mb-2"
          >
            ← 개발자
          </Link>
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="shrink-0 px-3 py-2 font-bold hover:bg-accent"
            >
              {label}
            </a>
          ))}
        </nav>

        <main className="flex min-w-0 flex-col gap-8">
          <section
            id="overview"
            className="flex scroll-mt-6 flex-wrap items-end justify-between gap-6"
          >
            <div className="flex min-w-0 flex-col gap-2">
              <p className="font-mono text-sm text-muted-foreground">
                NARU / DEVELOPERS / _naru
              </p>
              <h1 className="text-4xl font-bold tracking-tight">
                내 사이트 코드
              </h1>
              <p className="break-all text-muted-foreground">
                <span className="font-mono">
                  {new URL(getHomepageUrl(site)).host}
                </span>
                {current ? (
                  <>
                    {" · 지금 릴리스 "}
                    <span className="font-mono">{short(current.revision)}</span>
                    {` · ${when(current.created_at)}`}
                  </>
                ) : (
                  " · 아직 릴리스가 없어요"
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/files"
                className={`${BUTTON} press bg-primary text-primary-foreground`}
              >
                파일 관리
              </Link>
              <Link
                href="/docs/1.1.0/database#code"
                className={`${BUTTON} bg-card`}
              >
                사이트 코드 길잡이
              </Link>
            </div>
          </section>

          <Problems refused={refused} days={PROBLEM_DAYS} />

          <section
            id="releases"
            aria-labelledby="releases-h"
            className={`${PANEL} scroll-mt-6`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-2 border-line bg-muted px-5 py-3.5">
              <h2 id="releases-h" className="text-lg font-bold">
                릴리스
              </h2>
              <span className="text-sm text-muted-foreground">
                나루는 지금 릴리스와 바뀌는 중인 릴리스만 보관해요
              </span>
            </div>
            {listed.length === 0 && refused.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">
                <code>_naru/</code> 폴더에 쿼리나 마이그레이션을 올리면
                릴리스돼요.
              </p>
            ) : (
              <ol className="flex flex-col">
                {listed.map((release) => {
                  const label =
                    release === current
                      ? "지금"
                      : current && release.id > current.id
                        ? "적용 중"
                        : "지난";
                  return (
                    <li
                      key={release.id}
                      className="grid gap-1 border-b border-border px-5 py-4 last:border-b-0 sm:grid-cols-[5rem_minmax(0,1fr)]"
                    >
                      <span
                        className={`text-sm font-bold ${
                          label === "지금"
                            ? "text-link"
                            : "text-muted-foreground"
                        }`}
                      >
                        {label}
                      </span>
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="break-all font-mono">
                          {short(release.revision)}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {when(release.created_at)}
                          {source(
                            release.github_repository,
                            release.github_sha,
                          )}
                          {label === "지난" && " · 곧 지워져요"}
                        </span>
                        {release === current && files && (
                          <span className="text-sm text-muted-foreground">
                            마이그레이션 {files.migrations.length}개 · 쿼리 파일{" "}
                            {files.queries}개 · 뮤테이션 파일 {files.mutations}
                            개 · 라우트 {files.routes ? "있음" : "없음"}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
                {refused.map((deployment) => (
                  <li
                    key={deployment.id}
                    className="grid gap-1 border-b border-border px-5 py-4 last:border-b-0 sm:grid-cols-[5rem_minmax(0,1fr)]"
                  >
                    <span className="text-sm font-bold text-destructive">
                      거절됨
                    </span>
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="break-all font-mono">
                        {deployment.where}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {when(new Date(deployment.at))} · GitHub
                      </span>
                      {deployment.message && (
                        <span className="break-words text-sm">
                          {deployment.message}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <div className="grid items-start gap-8 lg:grid-cols-2">
            <DatabaseAndUsage migrations={files?.migrations ?? null} />
          </div>
        </main>
      </div>
    </div>
  );
}
