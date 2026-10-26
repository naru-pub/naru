import type { Metadata } from "next";
import { mcpResource } from "@/lib/mcp/oauth";
import { HelpPage, Section } from "../HelpPage";

export const metadata: Metadata = {
  title: "MCP 연결 | 나루",
  description: "MCP를 지원하는 앱에서 나루 사이트의 파일을 읽고 고치는 방법",
};

const sections = [
  ["connect", "01 · 연결하기"],
  ["ask", "02 · 이렇게 부탁해 보세요"],
  ["tools", "03 · 앱이 할 수 있는 일"],
  ["limits", "04 · 한도"],
  ["disconnect", "05 · 연결 끊기"],
] as const;

const asks = [
  "내 나루 홈페이지의 index.html을 읽고, 자기소개를 더 따뜻한 말투로 고쳐 줘.",
  "diary 폴더에 오늘 날짜로 일기 페이지를 하나 만들고, index.html에 링크를 달아 줘.",
  "내 홈페이지 파일들을 보고 깨진 링크가 있는지 찾아 줘.",
  "style.css의 색을 가을 느낌으로 바꿔 줘. 바꾸기 전에 무엇을 바꿀지 먼저 알려 줘.",
];

const tools: [string, string, string][] = [
  ["get_site", "읽기", "사이트 주소, 제목, 마지막 수정 시각, 서포터 기간"],
  ["list_files", "읽기", "폴더 아래 파일과 크기, 수정 시각"],
  ["read_file", "읽기", "텍스트 파일의 내용, 이미지"],
  ["write_file", "수정", "파일을 만들거나 통째로 바꾸고 바로 공개"],
  ["move_file", "수정", "파일 옮기기, 이름 바꾸기"],
  ["delete_file", "수정", "파일 지우기 (되돌릴 수 없음)"],
];

export default function McpHelp() {
  return (
    <HelpPage
      current="mcp"
      path="MCP"
      title="AI 앱에게 홈페이지 맡기기"
      lead={
        <>
          MCP(Model Context Protocol)는 AI 앱이 다른 서비스를 쓸 수 있게 하는
          연결 방법이에요. MCP를 지원하는 앱을 나루에 연결하면, 그 앱에게 말로
          부탁해서 내 홈페이지의 파일을 읽고, 만들고, 고칠 수 있어요. 서포터
          기능이에요.
        </>
      }
      links={
        <>
          <a href="/account">연결된 앱 보기 →</a>
          <a href="/supporter">서포터 →</a>
        </>
      }
      sections={sections}
    >
      <Section id="connect" title="01 · 연결하기">
        <ol className="list-decimal space-y-3 pl-6">
          <li>
            앱의 MCP 서버(커넥터) 추가 화면에 아래 주소를 넣으세요.
            <pre className="mt-2 overflow-x-auto rounded border bg-muted px-4 py-2 text-sm">
              <code>{mcpResource()}</code>
            </pre>
          </li>
          <li>앱이 나루 로그인 화면을 열어요. 나루 계정으로 로그인하세요.</li>
          <li>
            연결할 앱의 이름과 돌아갈 주소를 확인하고, 허용할 일을 고른 뒤
            ‘연결’을 누르세요. 읽기만 허용하면 앱은 파일을 바꾸지 못해요.
          </li>
        </ol>
        <p>
          앱 이름은 앱이 스스로 밝힌 것이에요. 연결 화면에 보이는 돌아갈 주소가
          쓰려던 앱의 주소인지 확인하세요.
        </p>
      </Section>

      <Section id="ask" title="02 · 이렇게 부탁해 보세요">
        <p>
          연결한 뒤에는 앱과 대화하듯 부탁하면 돼요. 어느 파일인지, 무엇을
          바꾸고 싶은지 구체적으로 말할수록 좋아요.
        </p>
        <ul className="space-y-3">
          {asks.map((ask) => (
            <li key={ask} className="border-l-4 border-line bg-muted px-4 py-2">
              {ask}
            </li>
          ))}
        </ul>
        <p>
          앱이 파일을 저장하면 그 즉시 홈페이지에 공개돼요. 중요한 페이지는
          바꾸기 전에 무엇을 바꿀지 먼저 보여 달라고 하세요. 앱이 고친 파일은{" "}
          <a href="/files">파일 편집기</a>에서도 바로 보이고, 거기서 다시 고칠
          수 있어요.
        </p>
      </Section>

      <Section id="tools" title="03 · 앱이 할 수 있는 일">
        <p>
          연결된 앱은 내 사이트 하나의 파일만 다뤄요. 계정 설정, 결제,
          데이터베이스, 커스텀 도메인에는 닿지 않아요.
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
          <code>_naru/collections.json</code>처럼 <code>_naru/</code> 폴더에
          저장한 파일도 파일 편집기에서 저장할 때와 똑같이 적용돼요.
        </p>
      </Section>

      <Section id="limits" title="04 · 한도">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            파일 하나는 10 MB까지, <a href="/help/files#limits">파일 편집기</a>
            와 같은 형식만 올릴 수 있어요.
          </li>
          <li>
            <code>read_file</code>은 1 MB까지의 텍스트와 이미지를 돌려줘요.
            그보다 큰 파일은 주소만 알려 줘요.
          </li>
          <li>
            <code>index.html</code>은 지우거나 옮길 수 없어요.
          </li>
          <li>연결 하나는 분당 120번까지 요청할 수 있어요.</li>
        </ul>
      </Section>

      <Section id="disconnect" title="05 · 연결 끊기">
        <p>
          <a href="/account">계정</a>의 ‘MCP 연결’에서 앱마다 ‘연결 끊기’를
          누르면 그 앱은 바로 사이트에 닿지 못해요. 30일 동안 쓰지 않은 연결은
          다시 로그인해야 해요. 서포터 기간이 끝나면 연결은 남지만, 다시
          서포터가 될 때까지 앱이 사이트에 닿지 못해요.
        </p>
      </Section>
    </HelpPage>
  );
}
