import type { Metadata } from "next";
import Link from "next/link";
import { CopyText } from "@/components/CopyText";
import { Button } from "@/components/ui/button";
import { validateRequest } from "@/lib/auth";
import { mcpResource } from "@/lib/mcp/oauth";

export const metadata: Metadata = {
  title: "AI 앱 연결하기 | 나루",
  description:
    "쓰던 AI 앱을 나루에 연결하고, 말로 부탁해서 홈페이지를 만들어요.",
};

const CLAUDE_LISTING = "https://claude.ai/directory/naru";
const CHATGPT_LISTING =
  "https://chatgpt.com/plugins/plugin_asdk_app_6adb58fcd698819188aea50b247bfed4";

const STEPS = [
  "앱이 나루 로그인 화면을 열어요. 나루 계정으로 로그인하세요.",
  "허용할 일을 고르세요. 읽기만 허용하면 앱은 파일을 바꾸지 못해요.",
  "앱에게 말해 보세요. “나루에서 내 홈페이지 파일들을 보여 줘.”",
];

// Where the home page, the editor and the nav send someone to connect an app.
// /mcp itself is the MCP endpoint; the whole story is the guide at /docs/ai.
export default async function ConnectAiApp() {
  const { user } = await validateRequest();
  const serverUrl = mcpResource();

  return (
    <div className="bg-background min-h-screen px-4 py-10 sm:px-6">
      <main className="mx-auto flex max-w-[680px] flex-col gap-6">
        <div className="space-y-2.5">
          <h1 className="text-3xl font-bold tracking-tight">AI 앱 연결하기</h1>
          <p className="leading-relaxed text-muted-foreground">
            한 번만 연결하면 돼요. 어떤 일을 허용할지는 연결할 때 직접 고르고,
            언제든{" "}
            <Link
              href="/account"
              className="text-link underline-offset-4 hover:underline"
            >
              계정 관리
            </Link>
            에서 끊을 수 있어요.
          </p>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-4">
          <Listing
            title="Claude를 쓴다면"
            body="디렉터리에서 나루를 찾아 바로 추가할 수 있어요."
            href={CLAUDE_LISTING}
            action="디렉터리에서 추가 →"
          />
          <Listing
            title="ChatGPT를 쓴다면"
            body="플러그인에서 나루를 찾아 바로 추가할 수 있어요."
            href={CHATGPT_LISTING}
            action="플러그인 추가 →"
          />
          <div className="col-span-full flex flex-col gap-3 border-2 border-line bg-card p-5">
            <h2 className="text-lg font-bold">다른 앱을 쓴다면</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              앱에 MCP 서버로 이 주소를 넣으세요. Codex, Claude Code 등
            </p>
            <div className="flex items-center gap-2">
              <code className="flex h-9 min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap border-2 border-line px-3 font-mono text-sm">
                {serverUrl}
              </code>
              <CopyText text={serverUrl} label="MCP 서버 주소" />
            </div>
          </div>
        </div>

        <ol className="flex flex-col gap-3 leading-relaxed">
          {STEPS.map((step, index) => (
            <li key={step} className="flex gap-3">
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center bg-foreground font-mono text-sm text-background"
              >
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        <div className="border-2 border-line bg-card text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-2 border-border px-4 py-3.5">
            <span className="font-medium">파일 읽기, 만들기, 고치기</span>
            <span className="text-muted-foreground">나루 계정이면 누구나</span>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3.5">
            <span className="font-medium">
              방명록, 블로그 같은 데이터베이스
            </span>
            <Link
              href="/supporter?for=database"
              className="text-link underline-offset-4 hover:underline"
            >
              서포터 플랜 →
            </Link>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          {!user && (
            <>
              아직 계정이 없다면{" "}
              <Link
                href="/signup"
                className="text-link underline-offset-4 hover:underline"
              >
                먼저 내 주소를 만드세요
              </Link>
              .{" "}
            </>
          )}
          무엇을 부탁할 수 있는지는{" "}
          <Link
            href="/docs/ai"
            className="text-link underline-offset-4 hover:underline"
          >
            AI 앱 연결 길잡이
          </Link>
          에 있어요.
        </p>
      </main>
    </div>
  );
}

function Listing({
  title,
  body,
  href,
  action,
}: {
  title: string;
  body: string;
  href: string;
  action: string;
}) {
  return (
    <div className="flex flex-col gap-3 border-2 border-line bg-card p-5">
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="flex-1 text-sm leading-relaxed text-muted-foreground">
        {body}
      </p>
      <Button asChild>
        <a href={href} target="_blank" rel="noopener">
          {action}
        </a>
      </Button>
    </div>
  );
}
