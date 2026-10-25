import type { Metadata } from "next";
import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import { authoredTemplates } from "@/lib/board/updates";
import { mcpResource } from "@/lib/mcp/oauth";

export const metadata: Metadata = {
  title: "개발자 | 나루",
  description:
    "사이트 코드와 Data SDK로 나루 사이트를 만들고 템플릿으로 나누는 사람을 위한 곳",
};

// The SDK version this page is written for; its guides and reference.
const SDK_VERSION = "1.1.0";
const GUIDE = `/docs/${SDK_VERSION}/database`;
const REPOSITORY = "https://github.com/naru-pub/naru/tree/main";
const NEW_TEMPLATE = "/board/new?kind=template";

const REFERENCE = [
  { href: `/docs/sdk/${SDK_VERSION}`, title: "SDK 레퍼런스" },
  { href: `${GUIDE}#code`, title: "ctx와 사이트 코드" },
  { href: `${GUIDE}#errors`, title: "한도와 오류 코드" },
];

const TOOLS = [
  {
    href: `${REPOSITORY}/sdk#readme`,
    title: "@naru-pub/sdk",
    note: `${SDK_VERSION}-dev`,
    command: "npm install @naru-pub/sdk@dev",
    summary: "번들러와 타입 검사를 쓸 때",
  },
  {
    href: "https://github.com/naru-pub/actions",
    title: "GitHub Action",
    note: "naru-pub/actions",
  },
  {
    href: "/docs/mcp",
    title: "MCP 서버",
    note: mcpResource(),
    summary: "AI 도구에서 내 사이트의 파일과 데이터베이스를 다뤄요.",
  },
];

// One template from an empty folder: the guide's examples, cut down.
const MIGRATION = `-- _naru/migrations/0001_posts.sql
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`;

const QUERY = `// _naru/queries/board.js
export async function recent(ctx) {
  const { rows } = await ctx.sql\`
    SELECT id, title FROM posts ORDER BY id DESC LIMIT 20\`;
  return rows;
}`;

const PAGE = `<!-- index.html -->
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/${SDK_VERSION}/naru.js";
  const naru = createNaru();
  const posts = await naru.query("board:recent");
</script>`;

const NARU_DEV = `npx @naru-pub/dev ./site --site demo
# naru-dev: demo at http://localhost:4000/`;

// The step the template's source form shows, for the signed-in author.
const workflow = (owner: string) => `# .github/workflows/naru.yml
permissions:
  id-token: write
steps:
  - uses: naru-pub/actions/deploy@v1
    with:
      dir: site
      template-owner: ${owner}`;

const PANEL = "border-2 border-line bg-card";
const PANEL_HEADING =
  "border-b-2 border-line bg-muted px-5 py-3.5 text-lg font-bold";
const ITEM =
  "flex flex-col gap-1 border-b border-border py-3 last:border-b-0 last:pb-0";
const LINK = "font-bold text-link underline-offset-4 hover:underline";
const BUTTON =
  "inline-flex min-h-11 items-center border-2 border-line px-5 font-bold";

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className="min-w-0 overflow-x-auto bg-foreground p-4 font-mono text-sm leading-7 text-background"
    >
      <code>{code}</code>
    </pre>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4 border-b border-border px-5 py-6 last:border-b-0">
      <span
        aria-hidden="true"
        className="flex size-8 flex-none items-center justify-center border-2 border-line font-mono font-semibold"
      >
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h3 className="text-lg font-bold">{title}</h3>
        {children}
      </div>
    </li>
  );
}

export default async function DevelopersPage() {
  const { user } = await validateRequest();
  const templates = user ? await authoredTemplates(user.id) : [];

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-7xl flex-col gap-10 px-4 pb-16 pt-10 sm:px-6 lg:px-8">
        <section className="flex flex-wrap items-end justify-between gap-x-8 gap-y-6">
          <div className="flex max-w-2xl flex-[1_1_32rem] flex-col gap-3">
            <p className="font-mono text-sm text-muted-foreground">
              NARU / DEVELOPERS · SDK {SDK_VERSION}
            </p>
            <h1 className="text-4xl font-bold tracking-tight">
              나루에서 만들기
            </h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              사이트 코드(_naru/)와 Data SDK로 템플릿을 만들어 나누는 사람을
              위한 곳이에요. 빈 폴더에서 공개한 템플릿까지 세 단계예요.
            </p>
            <p className="text-sm text-muted-foreground">
              SDK {SDK_VERSION}은 아직 만드는 중이라 바뀔 수 있어요. 안정 버전은{" "}
              <Link href="/docs/1.0.0/database" className={LINK}>
                1.0.0
              </Link>
              이에요.
            </p>
          </div>
          <Link
            href={NEW_TEMPLATE}
            className={`${BUTTON} press bg-primary text-primary-foreground`}
          >
            새 템플릿 공개하기
          </Link>
        </section>

        {user && (
          <section
            aria-labelledby="mine"
            className={`${PANEL} flex flex-col gap-2.5 p-5`}
          >
            <span className="flex items-baseline justify-between gap-3">
              <Link
                id="mine"
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
                아직 공개한 템플릿이 없어요. 아래 세 단계로 하나 만들어 봐요.
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
                      {template.version !== null && `v${template.version}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <div className="flex flex-wrap items-start gap-6">
          <section
            id="start"
            aria-labelledby="start-h"
            className={`${PANEL} min-w-0 flex-[999_1_40rem]`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-2 border-line bg-muted px-5 py-3.5">
              <h2 id="start-h" className="text-lg font-bold">
                처음부터 공개까지
              </h2>
              <span className="text-sm text-muted-foreground">
                게시판 글 목록을 보여 주는 템플릿 하나
              </span>
            </div>
            <ol>
              <Step number={1} title="테이블과 쿼리를 써요">
                <p className="leading-relaxed text-muted-foreground">
                  마이그레이션이 테이블을 만들고, 쿼리가 읽어서 페이지에
                  돌려줘요. 페이지는 SDK 주소를 그대로 가져와서 빌드가 필요
                  없어요.
                </p>
                <Snippet label="SQL 마이그레이션 예제" code={MIGRATION} />
                <Snippet label="JavaScript 쿼리 예제" code={QUERY} />
                <Snippet label="HTML 페이지 예제" code={PAGE} />
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <Link href={`${GUIDE}#code`} className={LINK}>
                    사이트 코드 길잡이 →
                  </Link>
                  <Link href={`${GUIDE}#members`} className={LINK}>
                    뮤테이션과 회원 →
                  </Link>
                </p>
              </Step>
              <Step number={2} title="내 컴퓨터에서 돌려 봐요">
                <p className="leading-relaxed text-muted-foreground">
                  naru-dev가 나루와 같은 엣지에서 페이지와 _naru/를 돌려요.
                  파일을 고치면 바로 다시 게시하고, 운영자와 회원 로그인은 클릭
                  한 번이에요.
                </p>
                <Snippet label="naru-dev 실행 예제" code={NARU_DEV} />
                <p className="text-sm">
                  <a href={`${REPOSITORY}/naru-dev#readme`} className={LINK}>
                    naru-dev 설명서 →
                  </a>
                </p>
              </Step>
              <Step number={3} title="템플릿으로 공개해요">
                <p className="leading-relaxed text-muted-foreground">
                  게시판에 템플릿 글을 쓰고, 내 사이트의 폴더나 GitHub 저장소를
                  골라요. GitHub에서 공개하면 워크플로가 돌 때마다 새 버전이
                  올라가고, 커밋 메시지가 버전 설명이 돼요.
                </p>
                <Snippet
                  label="GitHub 워크플로 예제"
                  code={workflow(user?.loginName ?? "demo")}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Link href={NEW_TEMPLATE} className={`${BUTTON} bg-card`}>
                    템플릿 글 쓰기
                  </Link>
                  <span className="text-sm text-muted-foreground">
                    템플릿을 설치하면 _naru/도 함께 복사돼요.
                  </span>
                </div>
              </Step>
            </ol>
          </section>

          <aside className="flex min-w-0 flex-[1_1_18rem] flex-col gap-6">
            <section aria-labelledby="reference-h" className={PANEL}>
              <h2 id="reference-h" className={PANEL_HEADING}>
                찾아보기{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  SDK {SDK_VERSION}
                </span>
              </h2>
              <ul className="flex flex-col px-5 pb-4 pt-1 text-sm">
                {REFERENCE.map((item) => (
                  <li key={item.title} className={ITEM}>
                    <Link href={item.href} className={LINK}>
                      {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="tools-h" className={PANEL}>
              <h2 id="tools-h" className={PANEL_HEADING}>
                도구
              </h2>
              <ul className="flex flex-col px-5 pb-5 pt-1">
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
                    {tool.command && (
                      <code className="overflow-x-auto whitespace-nowrap border border-border bg-background px-2 py-1.5 font-mono text-sm">
                        {tool.command}
                      </code>
                    )}
                    {tool.summary && (
                      <span className="text-sm leading-relaxed text-muted-foreground">
                        {tool.summary}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
