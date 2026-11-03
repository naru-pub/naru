import type { Metadata } from "next";
import Link from "next/link";
import DocsNav from "./DocsNav";
import { LATEST_VERSION } from "./versions";

export const metadata: Metadata = {
  title: "길잡이 | 나루",
  description: "나루 홈페이지를 만들고 꾸미는 방법",
};

const GUIDES = [
  {
    href: "/docs/files",
    title: "파일 편집기",
    summary:
      "첫 페이지 고치기, 이미지 올리기, 저장과 미리보기, 파일 정리와 단축키.",
  },
  {
    href: "/docs/mcp",
    title: "AI 앱 연결",
    summary: "AI 앱을 연결해서 말로 부탁해 홈페이지 파일을 고쳐요.",
  },
  {
    href: "/docs/using-templates",
    title: "템플릿 쓰기",
    summary:
      "템플릿을 적용하고, 내 것으로 고치고, 업데이트하고, 연결을 끊어요.",
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
            길잡이
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            내 홈페이지를 만들고 꾸미는 방법을 모았어요.
          </p>
        </header>

        <div className="grid gap-6 md:grid-cols-3">
          {GUIDES.map((guide) => (
            <Link
              key={guide.href}
              href={guide.href}
              className="group block border-2 border-line bg-card p-6 transition-colors hover:bg-accent"
            >
              <h2 className="text-xl font-bold group-hover:text-link">
                {guide.title} →
              </h2>
              <p className="mt-3 leading-7 text-muted-foreground">
                {guide.summary}
              </p>
            </Link>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap gap-5 text-sm underline underline-offset-4">
          <Link href="/board">자랑에서 다른 홈페이지 구경하기 →</Link>
          <Link href="/developers">사이트 코드를 쓰고 싶다면 개발자 →</Link>
        </div>
      </div>
    </div>
  );
}
