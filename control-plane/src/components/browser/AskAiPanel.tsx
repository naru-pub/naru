"use client";

import { X } from "lucide-react";
import { CopyText } from "@/components/CopyText";
import { Button } from "@/components/ui/button";

// Things to ask a connected app about the open file. They stay on links, layout
// and colours, and leave the words on the page to its owner. "파일" keeps the
// Korean particle after a file name from depending on how the name ends.
function asksFor(path: string) {
  if (/\.html?$/i.test(path))
    return [
      `나루에서 ${path} 파일에 있는 깨진 링크를 찾아 줘.`,
      `나루에서 ${path} 파일 위쪽에 다른 페이지로 가는 메뉴를 달아 줘.`,
      `나루에서 ${path} 파일을 휴대폰에서도 보기 좋게 고쳐 줘.`,
    ];
  if (/\.css$/i.test(path))
    return [
      `나루에서 ${path} 파일의 색을 가을 느낌으로 바꿔 줘. 바꾸기 전에 무엇을 바꿀지 먼저 알려 줘.`,
      `나루에서 ${path} 파일을 보고 쓰이지 않는 규칙을 찾아 줘.`,
    ];
  return [`나루에서 ${path} 파일을 읽고, 어떤 파일인지 알려 줘.`];
}

// Naru MCP from the file editor: the app that does the asking is the owner's
// own, so this hands over the words to paste and the way to connect one.
export default function AskAiPanel({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="AI에게 부탁하기"
      className="fixed inset-0 z-50 flex flex-col gap-5 overflow-y-auto bg-background p-6 md:static md:z-auto md:w-[340px] md:shrink-0 md:border-l-2 md:border-line"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[22px] font-bold leading-snug tracking-tight">
          이 파일, AI에게
          <br />
          부탁해 볼까요?
        </h2>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onClose}
          aria-label="닫기"
          className="shrink-0"
        >
          <X />
        </Button>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        쓰던 AI 앱을 나루에 연결하면, 아래처럼 말로 부탁할 수 있어요. 앱이
        저장한 내용은 내 사이트에 바로 공개돼요.
      </p>
      <ul className="flex flex-col gap-2">
        {asksFor(path).map((ask, index) => (
          <li
            key={ask}
            className="flex items-center gap-2 border-2 border-line bg-card py-2.5 pl-3 pr-2"
          >
            <p className="min-w-0 flex-1 break-words text-[13px] leading-relaxed">
              {ask}
            </p>
            <CopyText
              text={ask}
              label={`부탁 ${index + 1}`}
              className="shrink-0"
            />
          </li>
        ))}
      </ul>
      <Button asChild size="lg">
        <a href="/ai" target="_blank" rel="noopener">
          AI 앱 연결하기 →
        </a>
      </Button>
      <p className="text-xs leading-relaxed text-muted-foreground">
        이미 연결했다면 복사해서 앱에 붙여 넣으세요.
      </p>
    </aside>
  );
}
