import type { Metadata } from "next";
import Link from "next/link";
import DocsNav from "../DocsNav";
import CopyPrompt from "./CopyPrompt";
import { AI_PROMPT, AI_PROMPT_SDK_VERSION } from "@/lib/ai-prompt";

export const metadata: Metadata = {
  title: "AI로 사이트 만들기 | 나루",
  description:
    "Claude, ChatGPT 같은 AI에게 안내문을 붙여 넣고, 나루에서 바로 동작하는 사이트를 만드세요.",
};

const steps = [
  [
    "안내문 복사",
    "아래 안내문을 복사해 AI 대화창 맨 앞에 붙여 넣으세요. 나루의 규칙과 데이터 SDK 사용법이 담겨 있습니다.",
  ],
  [
    "만들고 싶은 것 설명",
    "이어서 원하는 사이트를 적으세요. 예: “친구들이 한 줄씩 남기는 방명록, 최신 글이 위로”.",
  ],
  [
    "파일 올리기",
    "AI가 준 파일을 파일 관리자에서 올리거나 새 파일을 만들어 붙여 넣으세요. _naru/collections.json을 올리면 데이터베이스 컬렉션이 저절로 만들어집니다.",
  ],
  [
    "고치기",
    "화면이 이상하면 브라우저 개발자 도구의 오류 메시지를 AI에게 그대로 보여 주세요.",
  ],
];

export default function AiDocs() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
        <DocsNav current="ai" version={AI_PROMPT_SDK_VERSION} />
        <header className="mb-12 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground">NARU / DOCS / AI</p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            AI로 사이트 만들기
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            AI가 만든 앱을 나루에 올리세요. 안내문을 붙여 넣으면 AI가 나루에서
            그대로 동작하는 파일과 데이터베이스 설정을 만듭니다.
          </p>
        </header>

        <ol className="mb-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {steps.map(([title, body], index) => (
            <li key={title} className="rounded-lg border p-5">
              <p className="text-sm text-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </p>
              <h2 className="mt-1 font-bold">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {body}
              </p>
            </li>
          ))}
        </ol>

        <section className="space-y-5 border-t pt-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="text-xl font-bold">안내문</h2>
            <CopyPrompt prompt={AI_PROMPT} />
          </div>
          <pre
            className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted p-4 text-sm leading-7 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            tabIndex={0}
            aria-label="AI에게 붙여 넣을 안내문"
          >
            {AI_PROMPT}
          </pre>
          <ul className="list-disc space-y-3 pl-6 leading-7 [&_a]:underline [&_a]:underline-offset-4">
            <li>
              데이터베이스는 <a href="/supporter">후원 플랜</a> 기능입니다.
              데이터 없이 화면만 있는 사이트는 누구나 올릴 수 있습니다.
            </li>
            <li>
              웹을 직접 읽는 AI에게는 <a href="/llms.txt">naru.pub/llms.txt</a>
              를 읽으라고 해도 됩니다. 같은 안내문이 들어 있습니다.
            </li>
            <li>
              빈 화면에서 시작하기 싫다면{" "}
              <Link href="/board?kind=template&database=1">
                데이터베이스 템플릿
              </Link>
              을 적용한 뒤 AI에게 고쳐 달라고 하세요.
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
