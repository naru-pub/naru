import type { Metadata } from "next";
import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import { listPosts } from "@/lib/board/posts";
import { authoredTemplates } from "@/lib/board/updates";
import Code from "../docs/Code";
import DocsNav from "../docs/DocsNav";
import { TemplateCard } from "../templates/TemplateCard";
import { LATEST_VERSION, guidePath } from "../docs/versions";

export const metadata: Metadata = {
  title: "개발자 | 나루",
  description:
    "서버 없이 커뮤니티, 실시간 타임라인, 갤러리를 만들어요. 사이트 코드와 Data SDK 문서를 모은 곳",
};

const GUIDE = "/docs/templates";
const NEW_TEMPLATE = "/templates/new";

const DATABASE_GUIDE = guidePath(LATEST_VERSION, "database");

// What a site can be, each with code from the guides.
const IDEAS: {
  title: string;
  summary: string;
  code: string;
  language?: "json";
  href: string;
}[] = [
  {
    title: "회원제 커뮤니티",
    summary: "나루 계정으로 로그인하고, 역할과 가입 승인을 사이트가 정해요.",
    code: `const member = await naru.members.session();
await member.mutate("board:write", {
  title, body,
});`,
    href: `${DATABASE_GUIDE}#members`,
  },
  {
    title: "실시간 타임라인",
    summary: "새 글이 올라오면 새로고침 없이 모두의 화면이 바뀌어요.",
    code: `naru.subscribe("board:recent", {},
  (posts) => render(posts));`,
    href: `${DATABASE_GUIDE}#live`,
  },
  {
    title: "방명록과 댓글",
    summary: "로그인 없이 방문자가 바로 글을 남겨요. 코드 몇 줄이면 돼요.",
    code: `await naru.collection("guestbook").add({
  name: "방문자", message: "안녕하세요!",
});`,
    href: `${DATABASE_GUIDE}#start`,
  },
  {
    title: "사진 갤러리",
    summary: "회원이 올린 이미지를 저장하고 글에 붙여요.",
    code: `const image =
  await member.media.upload(file);
await member.mutate("board:write",
  { title, body, image: image.url });`,
    href: guidePath(LATEST_VERSION, "media"),
  },
  {
    title: "검색되는 블로그",
    summary:
      "글마다 주소와 미리보기를 주고, 검색 엔진과 RSS에도 내보내요. _naru/routes.json에 주소만 적어요.",
    code: `{
  "version": 1,
  "include": ["/posts/*", "/feed.xml"]
}`,
    language: "json",
    href: `${DATABASE_GUIDE}#routes`,
  },
  {
    title: "앱 알림",
    summary: "답글이 달리면 회원의 나루 앱으로 알림을 보내요.",
    code: `await ctx.notify([authorId], {
  title: "새 답글", body, path: "/posts/1",
});`,
    href: `${DATABASE_GUIDE}#code`,
  },
];

const STEPS = [
  {
    title: "폴더에 써요",
    body: "테이블과 쿼리, 뮤테이션을 사이트의 _naru/ 폴더에 둬요. 빌드는 없어도 돼요.",
    code: `// _naru/queries/board.js
export async function recent(ctx) {
  const { rows } = await ctx.sql\`
    SELECT id, title FROM posts ORDER BY id DESC LIMIT 20\`;
  return rows;
}`,
    language: "javascript",
  },
  {
    title: "내 컴퓨터에서 돌려 봐요",
    body: "나루 계정 없이도 실제와 같은 엣지 코드로 시험해요.",
    code: "npx @naru-pub/dev ./site --site demo",
    language: "bash",
  },
  {
    title: "템플릿으로 나눠요",
    body: "등록하면 누구나 자기 사이트에 적용해요. 내 데이터는 공유되지 않아요.",
    code: `# .github/workflows/naru.yml
- uses: naru-pub/actions/deploy@v1
  with:
    dir: site
    template-owner: demo`,
    language: "yaml",
  },
] as const;

const GUIDES = [
  {
    href: guidePath(LATEST_VERSION, "database"),
    title: "데이터베이스",
    summary: "컬렉션과 사이트 코드로 페이지의 데이터를 저장하고 읽어요.",
  },
  {
    href: guidePath(LATEST_VERSION, "media"),
    title: "미디어",
    summary: "사이트가 올린 이미지와 파일을 다뤄요.",
  },
  {
    href: guidePath(LATEST_VERSION, "sdk"),
    title: "SDK 레퍼런스",
    summary: `Data SDK ${LATEST_VERSION}의 모든 함수와 타입.`,
  },
  {
    href: "/docs/dev",
    title: "로컬 개발",
    summary: "naru-dev로 사이트를 내 컴퓨터에서 돌려 보고 시험해요.",
  },
  {
    href: GUIDE,
    title: "템플릿 만들기",
    summary: "빈 폴더에서 공개한 템플릿까지 세 단계로 가요.",
  },
];

const PANEL = "border-2 border-line bg-card";
const LINK = "font-bold text-link underline-offset-4 hover:underline";
const BUTTON =
  "inline-flex min-h-11 items-center border-2 border-line px-5 font-bold";

export default async function DevelopersPage() {
  const { user } = await validateRequest();
  const [templates, { posts: running }] = await Promise.all([
    user ? authoredTemplates(user.id) : [],
    listPosts({
      kind: "template",
      usesDatabase: true,
      sort: "applied",
      page: 1,
    }),
  ]);

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-12 md:px-8">
        <div className="-mb-10">
          <DocsNav current="developers" version={LATEST_VERSION} />
        </div>
        <section className="flex flex-wrap items-end justify-between gap-x-8 gap-y-6">
          <div className="flex max-w-3xl flex-[1_1_32rem] flex-col gap-4">
            <p className="font-mono text-sm text-muted-foreground">
              NARU / DEVELOPERS
            </p>
            <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
              서버 없이 앱을 만들어요
            </h1>
            <p className="text-lg leading-relaxed text-muted-foreground">
              HTML 옆에 <code className="font-mono">_naru/</code> 폴더만 두면
              테이블과 쿼리, 회원 로그인, 실시간 업데이트가 붙어요. 서버를 띄울
              필요 없고, 만든 것은 템플릿으로 나눌 수 있어요.
            </p>
            <div className="flex flex-wrap gap-3 pt-1">
              <Link
                href={GUIDE}
                className={`${BUTTON} press bg-primary text-primary-foreground`}
              >
                첫 앱 만들기
              </Link>
              <Link href={NEW_TEMPLATE} className={`${BUTTON} press bg-card`}>
                템플릿 등록하기
              </Link>
            </div>
            <p className="text-sm text-muted-foreground">
              데이터베이스와 사이트 코드는{" "}
              <Link href="/supporter" className={LINK}>
                서포터
              </Link>{" "}
              기능이에요. 로컬 개발은 나루 계정 없이 바로 해 볼 수 있어요.
            </p>
          </div>
        </section>

        <section aria-labelledby="ideas" className="flex flex-col gap-5">
          <h2 id="ideas" className="text-2xl font-bold">
            무엇을 만들까요
          </h2>
          <div className="grid gap-6 md:grid-cols-2">
            {IDEAS.map((idea) => (
              <article
                key={idea.title}
                className={`${PANEL} flex min-w-0 flex-col gap-3 p-5`}
              >
                <h3 className="text-lg font-bold">{idea.title}</h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  {idea.summary}
                </p>
                <div className="mt-auto min-w-0">
                  <Code language={idea.language}>{idea.code}</Code>
                </div>
                <Link href={idea.href} className={`${LINK} text-sm`}>
                  어떻게 만드나요 →
                </Link>
              </article>
            ))}
          </div>
        </section>

        {running.length > 0 && (
          <section aria-labelledby="running" className="flex flex-col gap-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="space-y-1">
                <h2 id="running" className="text-2xl font-bold">
                  나루 위에서 돌아가는 것들
                </h2>
                <p className="text-sm text-muted-foreground">
                  다른 개발자들이 이렇게 만들어 나누고 있어요.
                </p>
              </div>
              <Link href="/templates?database=1" className={`${LINK} text-sm`}>
                모두 보기 →
              </Link>
            </div>
            <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {running.slice(0, 3).map((post) => (
                <TemplateCard key={post.id} post={post} detailed />
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="steps" className="flex flex-col gap-5">
          <h2 id="steps" className="text-2xl font-bold">
            만들어서 나누기까지
          </h2>
          <ol className="flex flex-col gap-8">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:gap-8"
              >
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-sm font-semibold text-link">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="text-lg font-bold">{step.title}</h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {step.body}
                  </p>
                </div>
                <div className="min-w-0">
                  <Code language={step.language}>{step.code}</Code>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="guides" className="flex flex-col gap-5">
          <h2 id="guides" className="text-2xl font-bold">
            문서
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {GUIDES.map((guide) => (
              <Link
                key={guide.href}
                href={guide.href}
                className="group block border-2 border-line bg-card p-6 transition-colors hover:bg-accent"
              >
                <h3 className="text-xl font-bold group-hover:text-link">
                  {guide.title} →
                </h3>
                <p className="mt-3 leading-7 text-muted-foreground">
                  {guide.summary}
                </p>
              </Link>
            ))}
          </div>
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
                아직 공개한 템플릿이 없어요.{" "}
                <Link href={GUIDE} className={LINK}>
                  템플릿 가이드
                </Link>
                를 따라 하나 만들어 봐요.
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
      </div>
    </div>
  );
}
