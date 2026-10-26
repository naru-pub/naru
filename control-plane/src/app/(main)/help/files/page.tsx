import type { Metadata } from "next";
import { ALLOWED_FILE_EXTENSIONS } from "@/lib/const";
import { HelpPage, Key, Section } from "../HelpPage";

export const metadata: Metadata = {
  title: "파일 편집기 | 나루",
  description:
    "나루의 파일 편집기로 홈페이지 파일을 만들고, 고치고, 올리는 방법",
};

const sections = [
  ["start", "01 · 첫 페이지 고치기"],
  ["create", "02 · 파일과 폴더 만들기"],
  ["upload", "03 · 이미지와 파일 올리기"],
  ["edit", "04 · 고치고 저장하기"],
  ["preview", "05 · 미리보기"],
  ["organize", "06 · 이름 바꾸기, 옮기기, 지우기"],
  ["keys", "07 · 단축키"],
  ["limits", "08 · 한도"],
] as const;

const keys: [string[], string][] = [
  [["Ctrl", "S"], "저장"],
  [["Ctrl", "P"], "파일 이름으로 찾아 열기"],
  [["Shift", "Alt", "F"], "보기 좋게 정리(포맷)"],
  [["F2"], "고른 파일 이름 바꾸기"],
];

export default function FilesHelp() {
  return (
    <HelpPage
      current="files"
      path="FILES"
      title="파일 편집기로 홈페이지 만들기"
      lead={
        <>
          나루 홈페이지는 HTML, CSS, 이미지 같은 파일로 만들어져요. 상단의
          ‘파일’에서 그 파일들을 브라우저 안에서 바로 만들고 고칠 수 있어요.
          저장하면 바로 홈페이지에 나타나요.
        </>
      }
      links={<a href="/files">파일 편집기 열기 →</a>}
      sections={sections}
    >
      <Section id="start" title="01 · 첫 페이지 고치기">
        <ol className="list-decimal space-y-3 pl-6">
          <li>
            로그인하고 상단의 <a href="/files">파일</a>을 누르세요. 왼쪽에 내
            홈페이지의 파일과 폴더가 나와요.
          </li>
          <li>
            <code>index.html</code>을 누르세요. 홈페이지 주소(
            <code>아이디.naru.pub</code>)로 들어온 사람이 처음 보는 페이지예요.
          </li>
          <li>
            가운데 편집기에서 글자를 고치고 ‘저장’을 누르세요. 홈페이지를
            새로고침하면 고친 내용이 보여요.
          </li>
        </ol>
        <p>
          다른 페이지는 파일 이름이 곧 주소예요. <code>about.html</code>은{" "}
          <code>아이디.naru.pub/about.html</code>에,{" "}
          <code>diary/first.html</code>은{" "}
          <code>아이디.naru.pub/diary/first.html</code>에 있어요.
        </p>
      </Section>

      <Section id="create" title="02 · 파일과 폴더 만들기">
        <p>
          왼쪽 파일 목록 위의 ‘파일’, ‘폴더’ 버튼을 누르고 이름을 쓴 뒤{" "}
          <Key>Enter</Key>를 누르세요. 버튼 위에 보이는 <code>$ cd ~/폴더</code>
          가 새로 생길 곳이에요. 목록에서 폴더를 고르면 그 안에 생겨요. 파일이나
          폴더를 마우스 오른쪽 버튼으로 눌러 ‘새 파일’, ‘새 폴더’를 골라도 돼요.
        </p>
        <ul className="list-disc space-y-3 pl-6">
          <li>
            파일 이름에는 <code>.html</code>, <code>.css</code>처럼 확장자를 꼭
            붙이세요. 확장자로 파일의 종류가 정해져요.
          </li>
          <li>
            새 <code>.html</code> 파일은 빈 파일이 아니라 페이지의 기본 뼈대가
            들어간 채로 만들어져요. <code>&lt;body&gt;</code>와{" "}
            <code>&lt;/body&gt;</code> 사이에 내용을 쓰면 돼요.
          </li>
        </ul>
      </Section>

      <Section id="upload" title="03 · 이미지와 파일 올리기">
        <p>
          왼쪽 위의 ‘업로드’ 버튼을 누르거나, 내 컴퓨터의 파일을 편집기 화면으로
          끌어다 놓으세요. 여러 개를 한 번에 올릴 수 있어요. 파일은 왼쪽에서
          고른 폴더에 들어가요. 아무것도 고르지 않았다면 맨 위 폴더에 들어가요.
        </p>
        <p>
          올린 이미지는 페이지에서 경로로 불러요. <code>images</code> 폴더에{" "}
          <code>cat.png</code>를 올렸다면 이렇게 써요.
        </p>
        <pre className="overflow-x-auto rounded border bg-muted px-4 py-2 text-sm">
          <code>{`<img src="images/cat.png" alt="우리 집 고양이">`}</code>
        </pre>
        <p>
          같은 이름의 파일이 이미 있으면 새로 올린 파일로 바뀌어요. 이미지는
          파일을 누르면 편집기 자리에서 보이고, ‘축소’, ‘원본’, ‘확대’로 크기를
          바꿔 볼 수 있어요.
        </p>
      </Section>

      <Section id="edit" title="04 · 고치고 저장하기">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            파일을 누르면 위쪽에 탭으로 열려요. 여러 파일을 열어 두고 탭을 눌러
            오갈 수 있어요.
          </li>
          <li>
            고치고 아직 저장하지 않은 파일은 탭에 ‘저장하지 않음’ 표시가 붙어요.
            ‘저장’ 버튼이나 <Key>Ctrl</Key> <Key>S</Key>(맥은 <Key>⌘</Key>{" "}
            <Key>S</Key>)로 저장하세요. 저장하지 않고 탭을 닫으려 하면 한 번 더
            물어봐요.
          </li>
          <li>
            저장하기 전에 ‘변경 사항’을 누르면 저장된 내용과 무엇이 달라졌는지
            나란히 볼 수 있어요. ‘편집’을 누르면 돌아와요.
          </li>
          <li>
            ‘포맷’은 들여쓰기와 줄바꿈을 보기 좋게 정리해요. 톱니바퀴 모양의
            편집기 설정에서 ‘저장할 때 포맷’, ‘자동 줄바꿈’, ‘미니맵’을 켜고 끌
            수 있어요.
          </li>
          <li>
            파일을 연 뒤에 다른 탭이나 MCP로 연결한 앱에서 같은 파일이
            저장되었다면, 저장할 때 알려 줘요. 덮어쓰거나, 저장된 버전을
            불러오거나, 저장하지 않고 둘 수 있어요.
          </li>
        </ul>
      </Section>

      <Section id="preview" title="05 · 미리보기">
        <p>
          HTML 파일을 연 채로 ‘미리보기’를 누르면 편집기 옆에 그 페이지가
          홈페이지에 보이는 모습 그대로 나와요. 저장할 때마다 다시 불러오니,
          CSS나 이미지를 바꾼 것도 바로 확인할 수 있어요. 새 탭에서 크게 보려면
          미리보기 위의 열기 버튼을 누르세요.
        </p>
        <p>
          미리보기는 저장된 파일을 보여 줘요. 고친 내용이 안 보이면 먼저
          저장하세요.
        </p>
      </Section>

      <Section id="organize" title="06 · 이름 바꾸기, 옮기기, 지우기">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>이름 바꾸기</strong>: 파일을 오른쪽 버튼으로 눌러 ‘이름
            변경’을 고르거나, 고른 뒤 <Key>F2</Key>를 누르세요. 편집기 위에
            보이는 파일 이름을 두 번 눌러도 돼요. 같은 이름이 이미 있으면
            덮어쓸지 물어봐요.
          </li>
          <li>
            <strong>옮기기</strong>: 파일을 끌어다 왼쪽 목록의 다른 폴더 위에
            놓으세요.
          </li>
          <li>
            <strong>지우기</strong>: 오른쪽 버튼 메뉴에서 ‘삭제’를 고르세요.
            폴더를 지우면 안의 파일도 모두 지워지고, 지우기 전에 어떤 파일이
            함께 지워지는지 보여 줘요. 지운 파일은 되돌릴 수 없어요.
          </li>
          <li>
            <code>index.html</code>은 홈페이지의 첫 페이지라 이름을 바꾸거나
            지울 수 없어요.
          </li>
        </ul>
        <p>
          오른쪽 버튼 메뉴의 ‘새 탭에서 열기’를 고르면 그 파일을 홈페이지 주소로
          열어요. 주소를 다른 사람에게 알려 줄 때 쓰세요.
        </p>
      </Section>

      <Section id="keys" title="07 · 단축키">
        <p>맥에서는 Ctrl 대신 ⌘(Command)를 누르세요.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="p-3">키</th>
                <th className="p-3">하는 일</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(([combo, action]) => (
                <tr key={action} className="border-b">
                  <td className="whitespace-nowrap p-3">
                    {combo.map((key, index) => (
                      <span key={key}>
                        {index > 0 && " + "}
                        <Key>{key}</Key>
                      </span>
                    ))}
                  </td>
                  <td className="p-3">{action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="limits" title="08 · 한도">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            파일 하나는 10 MB까지 올릴 수 있어요. 빈 파일은 올릴 수 없어요.
          </li>
          <li>
            올릴 수 있는 형식은 다음과 같아요:{" "}
            {ALLOWED_FILE_EXTENSIONS.map((extension, index) => (
              <span key={extension}>
                {index > 0 && ", "}
                <code>{extension}</code>
              </span>
            ))}
            .
          </li>
          <li>
            파일 이름은 255자까지이고, <code>/</code>는 쓸 수 없어요. 폴더는
            ‘폴더’ 버튼으로 만드세요.
          </li>
        </ul>
      </Section>
    </HelpPage>
  );
}
