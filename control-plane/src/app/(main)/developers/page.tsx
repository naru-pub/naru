import type { Metadata } from "next";
import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import { authoredTemplates } from "@/lib/board/updates";
import { userHasFeature } from "@/lib/entitlements";
import { mcpResource } from "@/lib/mcp/oauth";
import { getHomepageUrl } from "@/lib/site-urls";

export const metadata: Metadata = {
  title: "개발자 | 나루",
  description:
    "사이트 코드와 Data SDK로 나루 사이트를 만들고 템플릿으로 나누는 사람을 위한 곳",
};

// The SDK version this page is written for; its guides and reference.
const SDK_VERSION = "1.1.0";
const GUIDE = `/docs/${SDK_VERSION}/database`;
const REPOSITORY = "https://github.com/naru-pub/naru/tree/main";

const START = [
  {
    href: `${GUIDE}#code`,
    title: "사이트 코드가 있는 사이트 만들기",
    summary:
      "_naru/의 마이그레이션, 쿼리, 뮤테이션, 라우트. naru-dev로 내 컴퓨터에서 돌려 보고 올려요.",
  },
  {
    href: `${GUIDE}#start`,
    title: "페이지에서 SDK 쓰기",
    summary: "컬렉션, 쿼리와 뮤테이션 부르기, 실시간 쿼리, 회원 로그인.",
  },
  {
    href: `/docs/${SDK_VERSION}/media`,
    title: "미디어 올리기",
    summary: "이미지와 파일을 올리고 그 URL을 데이터에 저장해요.",
  },
  {
    href: "/board/new?kind=template",
    title: "템플릿 공개하기",
    summary:
      "내 사이트의 폴더에서, 또는 GitHub 저장소에서. 컬렉션과 사이트 코드도 함께 나눠요.",
  },
];

const REFERENCE = [
  {
    href: `/docs/sdk/${SDK_VERSION}`,
    title: "naru.js",
    mono: true,
    summary:
      "createNaru, collection, query, mutate, subscribe, members, auth, media.upload, NaruError",
  },
  {
    href: `${GUIDE}#code`,
    title: "@naru-pub/sdk/functions",
    mono: true,
    summary:
      "쿼리, 뮤테이션, 라우트의 ctx: sql, fail, member, owner, rolesOf, passwords, notify",
  },
  {
    href: `${GUIDE}#errors`,
    title: "한도와 오류 코드",
    mono: false,
    summary:
      "데이터 100 MiB, 사이트 코드 한 번에 작업 100번과 1 MiB, NOT_FOUND, ACCESS_DENIED, CONFLICT, RATE_LIMITED",
  },
];

const TOOLS = [
  {
    href: `${REPOSITORY}/naru-dev#readme`,
    title: "naru-dev",
    note: "@naru-pub/dev",
    command: "npx @naru-pub/dev ./site --site demo",
  },
  {
    href: `${REPOSITORY}/sdk#readme`,
    title: "@naru-pub/sdk",
    note: `${SDK_VERSION}-dev`,
    command: "npm install @naru-pub/sdk@dev",
  },
  {
    href: "https://github.com/naru-pub/actions",
    title: "GitHub Action",
    note: "naru-pub/actions",
    summary: "push할 때 사이트에 올려요.",
  },
  {
    href: "/docs/mcp",
    title: "MCP 서버",
    note: mcpResource(),
    summary: "AI 도구에서 내 사이트의 파일과 데이터베이스를 다뤄요.",
  },
];

const SNIPPET = `<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/${SDK_VERSION}/naru.js";
  const naru = createNaru();
  const posts = await naru.query("posts:recent", { board: "free" });
  const member = await naru.members.session();
</script>`;

const PANEL = "border-2 border-line bg-card";
const PANEL_HEADING =
  "border-b-2 border-line bg-muted px-5 py-3.5 text-lg font-bold";
const ITEM =
  "flex flex-col gap-1 border-b border-border py-3.5 last:border-b-0 last:pb-0";
const LINK = "font-bold text-link underline-offset-4 hover:underline";
const BUTTON =
  "inline-flex min-h-11 items-center border-2 border-line px-5 font-bold";

export default async function DevelopersPage() {
  const { user } = await validateRequest();
  const [templates, database] = user
    ? await Promise.all([
        authoredTemplates(user.id),
        userHasFeature(user.id, "database"),
      ])
    : [[], false];

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-7xl flex-col gap-10 px-4 pb-16 pt-10 sm:px-6 lg:px-8">
        <section className="flex flex-wrap items-end justify-between gap-8">
          <div className="flex max-w-2xl flex-[1_1_32rem] flex-col gap-3">
            <p className="font-mono text-sm text-muted-foreground">
              NARU / DEVELOPERS · SDK {SDK_VERSION}
            </p>
            <h1 className="text-4xl font-bold tracking-tight">
              나루에서 만들기
            </h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              사이트 코드(_naru/)와 Data SDK로 나루 사이트를 만들고, 템플릿으로
              나누는 사람을 위한 곳이에요. 길잡이, 레퍼런스, 도구, 그리고 내
              사이트와 템플릿으로 가는 길을 한곳에 모았어요.
            </p>
            <p className="text-sm text-muted-foreground">
              SDK {SDK_VERSION}은 아직 만드는 중이라 바뀔 수 있어요. 안정 버전은{" "}
              <Link href="/docs/1.0.0/database" className={LINK}>
                1.0.0
              </Link>
              이에요.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a
              href="#start"
              className={`${BUTTON} press bg-primary text-primary-foreground`}
            >
              시작하기
            </a>
            <Link
              href={`/docs/sdk/${SDK_VERSION}`}
              className={`${BUTTON} bg-card`}
            >
              SDK {SDK_VERSION} 레퍼런스
            </Link>
          </div>
        </section>

        {user && (
          <section aria-labelledby="mine" className="grid gap-5 md:grid-cols-2">
            <h2 id="mine" className="text-xl font-bold md:col-span-2">
              내 작업
            </h2>
            <Link
              href={database ? "/developers/site-code" : "/supporter"}
              className={`${PANEL} flex flex-col gap-2.5 p-5 hover:bg-accent`}
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-lg font-bold">내 사이트 코드</span>
                <span className="font-mono text-sm text-muted-foreground">
                  {new URL(getHomepageUrl(user.loginName)).host}
                </span>
              </span>
              <span className="text-sm text-muted-foreground">
                {database
                  ? "릴리스 · 문제 · 데이터베이스 · 사용량"
                  : "데이터베이스와 사이트 코드는 서포터가 쓸 수 있어요."}
              </span>
            </Link>
            <div className={`${PANEL} flex flex-col gap-2.5 p-5`}>
              <span className="flex items-baseline justify-between gap-3">
                <Link
                  href="/developers/templates"
                  className="text-lg font-bold underline-offset-4 hover:underline"
                >
                  내 템플릿 →
                </Link>
                <span className="font-mono text-sm text-muted-foreground">
                  {templates.length}개
                </span>
              </span>
              {templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  아직 공개한 템플릿이 없어요.{" "}
                  <Link href="/board/new?kind=template" className={LINK}>
                    템플릿 공개하기
                  </Link>
                </p>
              ) : (
                <ul className="flex flex-col text-sm">
                  {templates.map((template) => (
                    <li
                      key={template.postId}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border py-2 last:border-b-0"
                    >
                      <Link href={`/board/${template.postId}`} className={LINK}>
                        {template.title}
                      </Link>
                      <span className="text-muted-foreground">
                        {template.version !== null && `v${template.version} · `}
                        설치 {template.installs}곳
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        <div className="grid items-start gap-5 lg:grid-cols-3">
          <section id="start" aria-labelledby="start-h" className={PANEL}>
            <h2 id="start-h" className={PANEL_HEADING}>
              시작하기
            </h2>
            <ol className="flex flex-col px-5 pb-5 pt-2">
              {START.map((item) => (
                <li key={item.title} className={ITEM}>
                  <Link href={item.href} className={LINK}>
                    {item.title}
                  </Link>
                  <span className="text-sm leading-relaxed text-muted-foreground">
                    {item.summary}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="reference-h" className={PANEL}>
            <h2 id="reference-h" className={PANEL_HEADING}>
              레퍼런스{" "}
              <span className="text-sm font-normal text-muted-foreground">
                SDK {SDK_VERSION}
              </span>
            </h2>
            <ul className="flex flex-col px-5 pb-5 pt-2">
              {REFERENCE.map((item) => (
                <li key={item.title} className={ITEM}>
                  <Link
                    href={item.href}
                    className={`${LINK} ${item.mono ? "font-mono" : ""}`}
                  >
                    {item.title}
                  </Link>
                  <span className="text-sm leading-relaxed text-muted-foreground">
                    {item.summary}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="tools-h" className={PANEL}>
            <h2 id="tools-h" className={PANEL_HEADING}>
              도구
            </h2>
            <ul className="flex flex-col px-5 pb-5 pt-2">
              {TOOLS.map((tool) => (
                <li key={tool.title} className={`${ITEM} gap-1.5`}>
                  <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <a href={tool.href} className={LINK}>
                      {tool.title}
                    </a>
                    <span className="break-all font-mono text-xs text-muted-foreground">
                      {tool.note}
                    </span>
                  </span>
                  {tool.command ? (
                    <code className="overflow-x-auto whitespace-nowrap border border-border bg-background px-2 py-1.5 font-mono text-sm">
                      {tool.command}
                    </code>
                  ) : (
                    <span className="text-sm leading-relaxed text-muted-foreground">
                      {tool.summary}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section
          aria-labelledby="snippet-h"
          className={`${PANEL} grid lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]`}
        >
          <div className="flex flex-col gap-2.5 border-b-2 border-line p-6 lg:border-b-0 lg:border-r-2">
            <h2 id="snippet-h" className="text-xl font-bold">
              빌드 없이 한 줄로
            </h2>
            <p className="leading-relaxed text-muted-foreground">
              페이지는 나루가 주는 SDK 주소를 그대로 가져와요. 번들러를 쓰면 npm
              패키지로 같은 파일을 써요.
            </p>
            <a href={`${REPOSITORY}/sdk#readme`} className={`${LINK} text-sm`}>
              번들러와 함께 쓰기 →
            </a>
          </div>
          <pre
            tabIndex={0}
            aria-label="HTML 코드 예제"
            className="min-w-0 overflow-x-auto bg-foreground p-6 font-mono text-sm leading-7 text-background"
          >
            <code>{SNIPPET}</code>
          </pre>
        </section>
      </div>
    </div>
  );
}
