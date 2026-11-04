"use client";

import Link from "next/link";
import { useState } from "react";
import { BrowserFrame, SiteAddress } from "@/components/BrowserFrame";
import { Button } from "@/components/ui/button";

// The home page's picture of Naru MCP: pick something to ask for, and a sample
// site changes. The asks stay on the chores people hand off gladly, the links
// and colours and pages, and leave what the owner writes to the owner.
const SITE = {
  background: "#FFFFFF",
  color: "#111318",
  link: "#1E48D6",
  fixedLink: false,
  diary: false,
};

const asks = (today: string) => [
  {
    ...SITE,
    fixedLink: true,
    chip: "깨진 링크 찾기",
    prompt:
      "나루에서 내 홈페이지 파일들을 보고 깨진 링크가 있는지 찾아 줘. 있으면 고쳐 줘.",
    tools: ["파일 목록 읽음", "index.html 고침"],
    reply:
      "깨진 링크를 하나 찾았어요. 산책 지도가 없는 파일을 가리키고 있어서 walks.html로 고쳤어요. 글은 건드리지 않았어요.",
  },
  {
    ...SITE,
    background: "#FBF1E3",
    color: "#5B2E12",
    link: "#A8440F",
    chip: "가을 색으로",
    prompt: "나루에서 style.css의 색을 가을 느낌으로 바꿔 줘.",
    tools: ["style.css 읽음", "style.css 고침"],
    reply:
      "가을 색으로 바꿨어요. 바탕은 따뜻한 크림색, 글자는 짙은 갈색, 링크는 단풍색이에요.",
  },
  {
    ...SITE,
    diary: true,
    chip: "일기 페이지",
    prompt:
      "나루에서 diary 폴더에 오늘 날짜로 빈 일기 페이지를 하나 만들고, index.html에 링크를 달아 줘.",
    tools: [`diary/${today}.html 만듦`, "index.html 고침"],
    reply:
      "일기 페이지를 만들고 첫 화면에 링크를 달았어요. 내용은 비워 두었으니 편하게 적어 보세요.",
  },
];

/** `today` is the date a new diary page is named for, as YYYY-MM-DD. */
export function AskDemo({ today }: { today: string }) {
  const all = asks(today);
  const [picked, setPicked] = useState(0);
  const ask = all[picked];

  return (
    <section
      id="ask"
      aria-labelledby="ask-heading"
      className="mx-auto flex max-w-7xl scroll-mt-20 flex-wrap items-center gap-14 px-4 py-14 sm:px-6 lg:px-8"
    >
      <div className="flex min-w-0 flex-[1_1_400px] flex-col gap-6">
        <p className="flex items-center gap-2.5 text-sm font-medium text-muted-foreground">
          <span aria-hidden="true" className="size-2.5 bg-primary" />
          AI와 함께 만들기
        </p>
        <h2
          id="ask-heading"
          className="text-[clamp(2rem,4vw,3.25rem)] font-bold leading-[1.16] tracking-[-0.035em]"
        >
          <span className="highlight">말로</span> 부탁하면
          <br />
          홈페이지가 바뀌어요
        </h2>
        <p className="max-w-[30em] text-[17px] leading-relaxed text-muted-foreground">
          쓰던 AI 앱을 나루에 연결하세요. 코드를 몰라도, 대화만으로 내 사이트의
          파일을 읽고 만들고 고칠 수 있어요.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button asChild size="lg">
            <Link href="/ai">AI 앱 연결하기 →</Link>
          </Button>
          <p className="text-sm text-muted-foreground">
            Claude, ChatGPT, Codex 등
          </p>
        </div>
        <p className="border-t-2 border-border pt-4 text-sm leading-relaxed text-muted-foreground">
          파일을 다루는 일은 나루 계정만 있으면 돼요. 방명록처럼 데이터베이스를
          쓰는 기능에는 서포터 플랜이 필요해요.
        </p>
      </div>

      <div className="flex min-w-0 flex-[1.25_1_520px] flex-col gap-4">
        <p id="ask-label" className="text-sm font-medium text-muted-foreground">
          눌러서 부탁해 보세요
        </p>
        <div
          role="group"
          aria-labelledby="ask-label"
          className="flex flex-wrap gap-2"
        >
          {all.map((item, index) => (
            <Button
              key={item.chip}
              type="button"
              variant="outline"
              onClick={() => setPicked(index)}
              aria-pressed={index === picked}
              className={`h-11 ${index === picked ? "border-primary bg-accent" : ""}`}
            >
              {item.chip}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(270px,100%),1fr))] items-stretch gap-4">
          <div className="flex flex-col border-2 md:min-h-[400px] border-line bg-card">
            <div className="flex h-7 items-center justify-between border-b-2 border-line px-3 text-xs font-medium">
              <span>AI 앱</span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span aria-hidden="true" className="size-2 bg-primary" />
                나루 연결됨
              </span>
            </div>
            <div
              aria-live="polite"
              className="flex flex-1 flex-col gap-3.5 p-4 text-[15px] leading-relaxed"
            >
              <p className="max-w-[92%] self-end bg-accent px-3.5 py-3">
                {ask.prompt}
              </p>
              <ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
                {ask.tools.map((tool) => (
                  <li key={tool}>✓ {tool}</li>
                ))}
              </ul>
              <p>{ask.reply}</p>
            </div>
          </div>

          <BrowserFrame
            address={<SiteAddress loginName="내이름" />}
            className="flex flex-col shadow-hard-lg md:min-h-[400px]"
          >
            <div
              className="flex flex-1 flex-col gap-3.5 px-6 py-7 transition-colors"
              style={{ background: ask.background, color: ask.color }}
            >
              <h3 className="text-2xl font-bold tracking-tight">
                안녕하세요, 하루예요
              </h3>
              <p className="text-sm leading-7">
                오늘도 들러 주셔서 고마워요. 좋아하는 책과 동네 산책 이야기를
                천천히 적어 두는 곳이에요.
              </p>
              <div
                className="flex flex-col items-start gap-1.5 text-sm underline underline-offset-[3px]"
                style={{ color: ask.link }}
              >
                <span>책장</span>
                <span
                  className={
                    ask.fixedLink ? "bg-sun -ml-1 px-1 text-[#111318]" : ""
                  }
                >
                  산책 지도
                </span>
                {ask.diary && (
                  <span className="bg-sun -ml-1 px-1 text-[#111318]">
                    오늘의 일기
                  </span>
                )}
              </div>
            </div>
          </BrowserFrame>
        </div>
      </div>
    </section>
  );
}
