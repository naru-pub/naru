import type { Metadata } from "next";
import Link from "next/link";
import DocsNav from "./DocsNav";
import { LATEST_VERSION } from "./versions";

export const metadata: Metadata = {
  title: "도움말 | 나루",
  description: "나루 홈페이지를 만들고 꾸미는 방법, 사이트 코드와 SDK 문서",
};

const GROUPS = [
  {
    title: "홈페이지 만들기",
    guides: [
      {
        href: "/docs/files",
        title: "파일 편집기",
        summary:
          "첫 페이지 고치기, 이미지 올리기, 저장과 미리보기, 파일 정리와 단축키.",
      },
      {
        href: "/docs/mcp",
        title: "MCP 연결",
        summary:
          "AI 앱을 연결해서 말로 부탁해 홈페이지 파일을 고쳐요. 서포터 기능.",
      },
      {
        href: "/docs/using-templates",
        title: "템플릿 쓰기",
        summary:
          "템플릿을 적용하고, 내 것으로 고치고, 업데이트하고, 연결을 끊어요.",
      },
    ],
  },
  {
    title: "개발",
    guides: [
      {
        href: `/docs/${LATEST_VERSION}/database`,
        title: "데이터베이스",
        summary: "컬렉션과 사이트 코드로 페이지의 데이터를 저장하고 읽어요.",
      },
      {
        href: `/docs/${LATEST_VERSION}/media`,
        title: "미디어",
        summary: "사이트가 올린 이미지와 파일을 다뤄요.",
      },
      {
        href: `/docs/sdk/${LATEST_VERSION}`,
        title: "SDK 레퍼런스",
        summary: `Data SDK ${LATEST_VERSION}의 모든 함수와 타입.`,
      },
      {
        href: "/docs/dev",
        title: "로컬 개발",
        summary: "naru-dev로 사이트를 내 컴퓨터에서 돌려 보고 시험해요.",
      },
      {
        href: "/docs/templates",
        title: "템플릿 만들기",
        summary: "빈 폴더에서 공개한 템플릿까지 세 단계로 가요.",
      },
    ],
  },
];

export default function DocsIndex() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
        <DocsNav current="home" version={LATEST_VERSION} />
        <header className="mb-12 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground">NARU / DOCS</p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            도움말
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            내 홈페이지를 만들고 꾸미는 방법부터 사이트 코드를 쓰는 방법까지
            모았어요.
          </p>
        </header>

        <div className="space-y-12">
          {GROUPS.map((group) => (
            <section key={group.title} className="space-y-5">
              <h2 className="text-xl font-bold">{group.title}</h2>
              <div className="grid gap-6 md:grid-cols-2">
                {group.guides.map((guide) => (
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
          ))}
        </div>

        <div className="mt-10 flex flex-wrap gap-5 text-sm underline underline-offset-4">
          <Link href="/board">게시판에서 다른 홈페이지 구경하기 →</Link>
        </div>
      </div>
    </div>
  );
}
