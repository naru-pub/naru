import type { Metadata } from "next";
import Link from "next/link";
import { HelpNav } from "./HelpPage";

export const metadata: Metadata = {
  title: "도움말 | 나루",
  description: "나루 홈페이지를 만들고 꾸미는 방법",
};

const guides = [
  {
    href: "/help/files",
    title: "파일 편집기",
    summary:
      "첫 페이지 고치기, 이미지 올리기, 저장과 미리보기, 파일 정리와 단축키.",
  },
  {
    href: "/help/mcp",
    title: "MCP 연결",
    summary:
      "AI 앱을 연결해서 말로 부탁해 홈페이지 파일을 고쳐요. 서포터 기능.",
  },
];

export default function HelpIndex() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
        <HelpNav current="home" />
        <header className="mb-12 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground">NARU / HELP</p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            도움말
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            나루에서 내 홈페이지를 만들고 꾸미는 방법이에요.
          </p>
        </header>

        <div className="grid gap-6 md:grid-cols-2">
          {guides.map((guide) => (
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
          <Link href="/board">게시판에서 다른 홈페이지 구경하기 →</Link>
          <Link href="/developers">템플릿을 만들어 나누려면: 개발자 →</Link>
        </div>
      </div>
    </div>
  );
}
