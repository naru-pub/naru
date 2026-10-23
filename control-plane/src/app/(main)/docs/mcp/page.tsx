import type { Metadata } from "next";
import type { ReactNode } from "react";
import DocsNav from "../DocsNav";
import { mcpResource } from "@/lib/mcp/oauth";

export const metadata: Metadata = {
  title: "MCP 연결 | 나루",
  description: "MCP를 지원하는 앱에서 나루 사이트의 파일을 읽고 고치는 방법",
};

const sections = [
  ["connect", "01 · 연결하기"],
  ["tools", "02 · 앱이 할 수 있는 일"],
  ["limits", "03 · 한도"],
  ["disconnect", "04 · 연결 끊기"],
];

const tools: [string, string, string][] = [
  ["get_site", "읽기", "사이트 주소, 제목, 마지막 수정 시각, 후원 기간"],
  ["list_files", "읽기", "폴더 아래 파일과 크기, 수정 시각"],
  ["read_file", "읽기", "텍스트 파일의 내용, 이미지"],
  ["write_file", "수정", "파일을 만들거나 통째로 바꾸고 바로 공개"],
  ["move_file", "수정", "파일 옮기기, 이름 바꾸기"],
  ["delete_file", "수정", "파일 지우기 (되돌릴 수 없음)"],
];

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8 space-y-5 border-t pt-8">
      <h2 className="text-xl font-bold">{title}</h2>
      {children}
    </section>
  );
}

export default function McpDocs() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
        <DocsNav current="mcp" />
        <header className="mb-12 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground">NARU / DOCS / MCP</p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            다른 앱에서 사이트 파일을 다루세요.
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            MCP(Model Context Protocol)를 지원하는 앱을 나루에 연결하면, 그
            앱에서 내 사이트의 파일을 읽고, 만들고, 고칠 수 있습니다. 후원 플랜
            기능입니다.
          </p>
          <div className="flex flex-wrap gap-5 text-sm underline underline-offset-4">
            <a href="/account">연결된 앱 보기 →</a>
            <a href="/supporter">후원 플랜 →</a>
          </div>
        </header>

        <div className="grid gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
          <nav
            aria-label="문서 목차"
            className="self-start rounded-lg border p-5 lg:sticky lg:top-8"
          >
            <p className="mb-4 font-bold">이 페이지에서</p>
            <ul className="space-y-3 text-sm">
              {sections.map(([id, label]) => (
                <li key={id}>
                  <a
                    className="underline-offset-4 hover:underline"
                    href={`#${id}`}
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <article className="min-w-0 space-y-12 leading-8 [&_a]:underline [&_a]:underline-offset-4">
            <Section id="connect" title="01 · 연결하기">
              <ol className="list-decimal space-y-3 pl-6">
                <li>
                  앱의 MCP 서버(커넥터) 추가 화면에 아래 주소를 넣으세요.
                  <pre className="mt-2 overflow-x-auto rounded border bg-muted px-4 py-2 text-sm">
                    <code>{mcpResource()}</code>
                  </pre>
                </li>
                <li>
                  앱이 나루 로그인 화면을 엽니다. 나루 계정으로 로그인하세요.
                </li>
                <li>
                  연결할 앱의 이름과 돌아갈 주소를 확인하고, 허용할 일을 고른 뒤
                  ‘연결’을 누르세요. 읽기만 허용하면 앱은 파일을 바꾸지
                  못합니다.
                </li>
              </ol>
              <p>
                앱 이름은 앱이 스스로 밝힌 것입니다. 연결 화면에 보이는 돌아갈
                주소가 쓰려던 앱의 주소인지 확인하세요.
              </p>
            </Section>

            <Section id="tools" title="02 · 앱이 할 수 있는 일">
              <p>
                연결된 앱은 내 사이트 하나의 파일만 다룹니다. 계정 설정, 결제,
                데이터베이스, 커스텀 도메인에는 닿지 않습니다.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="p-3">도구</th>
                      <th className="p-3">권한</th>
                      <th className="p-3">하는 일</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tools.map(([name, scope, summary]) => (
                      <tr key={name} className="border-b">
                        <td className="p-3">
                          <code>{name}</code>
                        </td>
                        <td className="p-3">{scope}</td>
                        <td className="p-3">{summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                <code>_naru/collections.json</code>처럼 <code>_naru/</code>{" "}
                폴더에 저장한 파일도 파일 관리자에서 저장할 때와 똑같이
                적용됩니다.
              </p>
            </Section>

            <Section id="limits" title="03 · 한도">
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  파일 하나는 10 MB까지, 파일 관리자와 같은 형식만 올릴 수
                  있습니다.
                </li>
                <li>
                  <code>read_file</code>은 1 MB까지의 텍스트와 이미지를
                  돌려줍니다. 그보다 큰 파일은 주소만 알려 줍니다.
                </li>
                <li>
                  <code>index.html</code>은 지우거나 옮길 수 없습니다.
                </li>
                <li>연결 하나는 분당 120번까지 요청할 수 있습니다.</li>
              </ul>
            </Section>

            <Section id="disconnect" title="04 · 연결 끊기">
              <p>
                <a href="/account">계정</a>의 ‘MCP 연결’에서 앱마다 ‘연결
                끊기’를 누르면 그 앱은 바로 사이트에 닿지 못합니다. 30일 동안
                쓰지 않은 연결은 다시 로그인해야 합니다. 후원이 끝나면 연결은
                남지만, 다시 후원할 때까지 앱이 사이트에 닿지 못합니다.
              </p>
            </Section>
          </article>
        </div>
      </div>
    </div>
  );
}
