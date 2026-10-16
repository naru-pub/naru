import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import Code from "../../Code";
import DocsNav from "../../DocsNav";

export const metadata: Metadata = {
  title: "데이터베이스 사용 안내 | 나루",
  description:
    "나루 제어판과 웹 SDK로 블로그, 방명록, 관리자 글쓰기를 만드는 방법",
};

const sections = [
  ["start", "01 · 빠른 시작"],
  ["ideas", "02 · 나루가 일하는 방식"],
  ["php", "03 · PHP와 견주어 보기"],
  ["collections", "04 · 컬렉션과 공개 범위"],
  ["admin", "05 · 관리자 로그인"],
  ["members", "06 · 회원과 서버 함수"],
  ["write", "07 · 글 수정과 충돌 처리"],
  ["read", "08 · 목록·검색·페이지"],
  ["rules", "09 · 컬렉션 규칙"],
  ["recipes", "10 · 사용 예"],
  ["errors", "11 · 한도와 오류"],
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

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            {head.map((cell) => (
              <th key={cell} className="p-3">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b">
              {row.map((cell, column) => (
                <td key={column} className="p-3">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DatabaseDocs() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-5 py-12 md:px-8">
        <DocsNav current="database" version="1.1.0" />
        <header className="mb-12 max-w-3xl space-y-5">
          <p className="text-sm text-muted-foreground">
            NARU / DOCS / DATABASE / SDK 1.1.0
          </p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            정적 웹사이트에 데이터를 더하세요.
          </h1>
          <p className="text-lg leading-8 text-muted-foreground">
            별도 서버 없이 글을 공개하고, 방문자의 인사를 받고, 내 웹사이트에서
            글을 작성하세요.
          </p>
          <div className="flex flex-wrap gap-5 text-sm underline underline-offset-4">
            <a href="/database">데이터베이스 제어판 열기 →</a>
            <Link href="/board?kind=template&database=1">
              데이터베이스 템플릿 둘러보기 →
            </Link>
            <a href="/docs/sdk/1.1.0">SDK 레퍼런스 →</a>
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
            <Section id="start" title="01 · 빠른 시작">
              <p>
                <a href="/database">제어판</a>에서 <code>posts</code> 컬렉션을
                만들고 읽기를 공개로 바꾸세요. 제목이 있는 문서를 하나 저장한 뒤
                페이지에 아래 코드를 넣으세요.
              </p>
              <Code language="json">{`{
  "title": "첫 번째 글"
}`}</Code>
              <Code language="html">{`<ul id="posts"></ul>
<script type="module">
  import { createNaru } from "https://naru.pub/sdk/1.1.0/naru.js";

  const naru = createNaru();
  const { documents } = await naru.collection("posts").list();
  for (const post of documents) {
    const item = document.createElement("li");
    item.textContent = post.data.title;
    document.querySelector("#posts").append(item);
  }
</script>`}</Code>
              <h3 className="font-bold">방명록에 인사 남기기</h3>
              <p>
                제어판에서 <code>guestbook</code> 컬렉션을 만들고 읽기는
                ‘누구나’, 쓰기는 ‘누구나 생성만’으로 설정하세요.
              </p>
              <Code language="html">{`<button id="hello">인사 남기기</button>
<p id="result"></p>
<script type="module">
  import { createNaru } from "https://naru.pub/sdk/1.1.0/naru.js";
  const naru = createNaru();
  const button = document.querySelector("#hello");
  const result = document.querySelector("#result");
  button.onclick = async () => {
    button.disabled = true;
    try {
      const saved = await naru.collection("guestbook").add({
        name: "방문자", message: "안녕하세요!",
      });
      result.textContent = saved.data.message + " 저장됨";
    } catch (error) {
      result.textContent = "결과를 확인하지 못했습니다. 방명록을 확인하세요.";
      console.error(error);
    }
  };
</script>`}</Code>
            </Section>

            <Section id="ideas" title="02 · 나루가 일하는 방식">
              <p>
                나루의 데이터베이스는 서버 없이 정적 웹사이트에 데이터를
                더합니다. 그 대신 지켜야 할 생각이 몇 가지 있고, SDK의 모양은
                모두 여기서 나왔습니다.
              </p>
              <h3 className="font-bold">페이지는 방문자의 것입니다</h3>
              <p>
                페이지의 스크립트는 방문자의 브라우저에서 돌고, 방문자는 그
                코드를 마음대로 고칠 수 있습니다. 그래서 페이지가 정한 것은 믿을
                수 없습니다. 페이지는 보여 주고 요청할 뿐이고, 누가 무엇을 할 수
                있는지는 나루가 정합니다. 가격, 잔액, 권한, 주사위처럼 속이면 안
                되는 것은 모두 나루에서 정하세요.
              </p>
              <h3 className="font-bold">세 사람, 하나의 손잡이</h3>
              <p>
                요청하는 사람은 셋입니다. 로그인하지 않은{" "}
                <strong>방문자</strong>, 자기 나루 계정으로 로그인한{" "}
                <strong>회원</strong>, 사이트의 <strong>소유자</strong>입니다.
                셋 모두 같은 <code>collection(이름)</code>으로 같은 메서드를
                부릅니다. 허락할지는 요청한 사람을 보고 나루가 정하므로, 페이지
                코드가 역할마다 달라지지 않습니다.
              </p>
              <h3 className="font-bold">지키는 곳은 세 겹입니다</h3>
              <p>필요한 만큼만 쓰세요. 위에서부터 가장 단순합니다.</p>
              <Table
                head={["필요한 것", "쓸 것", "예"]}
                rows={[
                  [
                    "컬렉션 전체에 하나의 규칙",
                    <a key="a" href="#collections">
                      공개 범위
                    </a>,
                    "공지는 누구나 읽고 관리자만 쓴다",
                  ],
                  [
                    "문서마다 다른 권한",
                    <a key="a" href="#rules">
                      컬렉션 규칙
                    </a>,
                    "비밀글은 글쓴이와 운영진만 읽는다",
                  ],
                  [
                    "여러 문서를 함께 바꾸는 일",
                    <a key="a" href="#members">
                      서버 함수
                    </a>,
                    "물건을 사면 잔액과 재고와 인벤토리가 한꺼번에 바뀐다",
                  ],
                ]}
              />
              <p>
                규칙은 페이지가 SDK로 바로 읽고 쓰는 길을 지키고, 서버 함수는
                페이지가 할 수 없는 일을 대신합니다. 함수 한 번은 트랜잭션
                하나라서, 다 되거나 아무것도 바뀌지 않습니다. 중간에 멈춘
                구매처럼 반쯤 된 상태는 생기지 않습니다.
              </p>
              <h3 className="font-bold">사이트 파일이 곧 설정입니다</h3>
              <p>
                컬렉션, 함수, 규칙은 사이트의 <code>_naru/</code> 폴더에 둡니다.
                사이트와 함께 GitHub에 올라가고, 템플릿을 설치하면 함께
                복사되며, 파일을 올리면 바로 적용됩니다. 제어판에서 하나씩
                누르지 않아도 사이트가 스스로 필요한 것을 갖춥니다. 다만 이미
                있는 컬렉션을 바꾸는 내용은 소유자가 제어판에서 확인한 뒤에
                적용됩니다. 이 파일들은 다른 사이트 파일처럼 누구나 볼 수 있으니
                비밀값을 넣지 마세요.
              </p>
              <h3 className="font-bold">작고 빠르게, 정해진 한도 안에서</h3>
              <p>
                모든 사이트가 서버를 나눠 쓰므로 함수와 규칙에는 한도가
                있습니다. 한 번에 데이터베이스 작업 100번, 수십 밀리초입니다.
                한도는 실수를 일찍 드러냅니다. 끝없는 반복이나 한 번에 모든 글을
                읽는 코드는 실패하고, 바꾼 것은 되돌려집니다. 많은 글을 다룰
                때는 <code>where</code>로 필요한 것만 읽고 쪽을 나누세요.
              </p>
              <h3 className="font-bold">오류는 방문자에게 보여 줄 수 있게</h3>
              <p>
                실패하면 <code>error.message</code>를 그대로 화면에 띄워도
                되도록, 나루의 오류는 한국어로, 함수와 규칙의{" "}
                <code>ctx.fail</code>은 사이트가 쓴 말 그대로 옵니다. 무엇이 왜
                실패했는지 개발자를 위한 설명은 <code>error.cause.message</code>
                에, 처리를 나눌 값은 <code>error.code</code>와{" "}
                <code>error.details</code>에 있습니다.
              </p>
            </Section>

            <Section id="php" title="03 · PHP와 견주어 보기">
              <p>
                그누보드나 PHP로 게시판을 만들어 봤다면, 나루에서도 하는 일은
                같습니다. 다만 서버 파일 대신 페이지의 스크립트가 SDK를 부르고,
                PHP에서 직접 짜던 검사는 서버 함수와 컬렉션 규칙이 맡습니다.
              </p>
              <Table
                head={["PHP에서", "나루에서"]}
                rows={[
                  [
                    <code key="c">CREATE TABLE</code>,
                    <>
                      <a href="#collections">
                        <code>_naru/collections.json</code>
                      </a>
                      에 컬렉션을 적거나 제어판에서 만듭니다.
                    </>,
                  ],
                  [
                    <code key="c">
                      SELECT … WHERE board = &apos;free&apos;
                    </code>,
                    <code key="n">
                      list({'{ filter: { board: "free" } }'})
                    </code>,
                  ],
                  [
                    <code key="c">WHERE title LIKE &apos;%봄%&apos;</code>,
                    <code key="n">
                      list({'{ where: { contains: ["title", "봄"] } }'})
                    </code>,
                  ],
                  [
                    <code key="c">LIMIT 20 OFFSET 40</code>,
                    <>
                      <code>size: 20</code>과 <code>nextCursor</code>로 다음
                      쪽을 읽습니다.
                    </>,
                  ],
                  [
                    <code key="c">INSERT</code>,
                    <>
                      <code>add(data)</code>, ID를 정하면{" "}
                      <code>set(id, data)</code>
                    </>,
                  ],
                  [
                    <code key="c">$_SESSION[&apos;mb_id&apos;]</code>,
                    <>
                      <a href="#members">회원 로그인</a> 뒤의{" "}
                      <code>member.id</code>
                    </>,
                  ],
                  [
                    <>
                      <code>write_update.php</code>의 권한·포인트 검사
                    </>,
                    <>
                      <a href="#members">서버 함수</a>(
                      <code>_naru/functions/</code>)나{" "}
                      <a href="#rules">컬렉션 규칙</a>(<code>_naru/rules/</code>
                      )
                    </>,
                  ],
                  [
                    <code key="c">alert(&apos;권한이 없습니다.&apos;)</code>,
                    <>
                      함수와 규칙의 <code>ctx.fail(코드, 메시지)</code>.
                      메시지가 그대로 방문자에게 보입니다.
                    </>,
                  ],
                ]}
              />
              <p>
                <code>_naru/</code>의 폴더도 PHP 사이트에 익숙한 자리가
                있습니다.
              </p>
              <Table
                head={["나루", "PHP 사이트에서", "다른 점"]}
                rows={[
                  [
                    <code key="n">_naru/collections.json</code>,
                    <>
                      <code>install.sql</code>의 <code>CREATE TABLE</code>
                    </>,
                    "열(칼럼)은 정하지 않습니다. 문서마다 JSON을 담습니다.",
                  ],
                  [
                    <code key="n">_naru/functions/</code>,
                    <>
                      폼이 보내는 <code>write_update.php</code> 같은 파일
                    </>,
                    <>
                      주소 대신 이름으로 부릅니다:{" "}
                      <code>member.call(&quot;shop:buy&quot;)</code>
                    </>,
                  ],
                  [
                    <code key="n">_naru/rules/</code>,
                    <>
                      페이지마다 맨 위에 쓰던{" "}
                      <code>if ($member[&apos;mb_level&apos;] &lt; 2)</code>{" "}
                      검사
                    </>,
                    "페이지가 아니라 데이터를 지킵니다. 한곳에 쓰면 모든 읽기와 쓰기에 적용됩니다.",
                  ],
                  [
                    <code key="n">_naru/modules/</code>,
                    <>
                      <code>include &apos;lib/common.lib.php&apos;</code>로 불러
                      쓰던 <code>lib/</code>
                    </>,
                    "함수와 규칙이 import합니다. 페이지에서 직접 부를 수는 없습니다.",
                  ],
                ]}
              />
              <p>
                실제 커뮤니티 하나를 통째로 옮긴 예는{" "}
                <a href="https://github.com/naru-pub/neo-avocado">
                  네오 아보카도
                </a>
                입니다. 아보카도 에디션(그누보드 기반)을 나루로 옮긴 것이라, PHP
                파일과 나루 파일을 나란히 견주어 볼 수 있습니다.
              </p>
            </Section>

            <Section id="collections" title="04 · 컬렉션과 공개 범위">
              <p>
                <strong>컬렉션</strong>은 문서를 모으는 곳이고,{" "}
                <strong>문서</strong>는 ID 하나와 JSON 데이터 하나입니다. 이름과
                문서 ID는 영문·숫자·<code>_</code>·<code>-</code> 1~64자입니다.
              </p>
              <Table
                head={["", "설정", "방문자가 할 수 있는 일"]}
                rows={[
                  ["읽기", "관리자만", "방문자는 읽을 수 없습니다."],
                  [
                    "읽기",
                    "누구나",
                    <>
                      <code>get</code>·<code>list</code>·<code>count</code>·
                      <code>pages</code>로 누구나 읽습니다.
                    </>,
                  ],
                  [
                    "읽기",
                    "회원",
                    <>
                      나루 계정으로 이 사이트에{" "}
                      <a href="#members">회원 로그인</a>한 방문자만 읽습니다.
                    </>,
                  ],
                  ["쓰기", "관리자만", "방문자는 쓸 수 없습니다."],
                  [
                    "쓰기",
                    "누구나 생성만",
                    <>
                      <code>add</code>로 새 문서만 만듭니다. 방명록에
                      알맞습니다.
                    </>,
                  ],
                  [
                    "쓰기",
                    "회원 생성, 자기 문서 덮어쓰기·삭제",
                    <>
                      회원은 <code>add</code>로 글을 쓰고, 자기가 만든 문서만
                      고치고 지웁니다. 게시판과 커뮤니티에 알맞습니다.
                    </>,
                  ],
                  [
                    "쓰기",
                    "누구나 생성·덮어쓰기·삭제",
                    "누구나 모든 문서를 바꾸고 지울 수 있습니다. 대부분은 필요 없습니다.",
                  ],
                ]}
              />
              <p>
                관리자는 <a href="#admin">로그인</a>하면 등록한 컬렉션을 공개
                범위와 상관없이 읽고 쓸 수 있습니다. 공개 읽기 컬렉션의 문서는
                누구나 읽을 수 있으니, 비공개로 둘 데이터는 ‘관리자만’ 읽는
                컬렉션에 따로 저장하세요.
              </p>
              <h3 className="font-bold">파일로 컬렉션 정하기</h3>
              <p>
                사이트 파일에 <code>_naru/collections.json</code>을 두면, 파일을
                올릴 때 나루가 없는 컬렉션을 만듭니다. 템플릿을 설치한 사람도
                제어판에서 하나씩 만들 필요가 없습니다. 이미 있는 컬렉션의 공개
                범위나 규칙을 바꾸는 내용은 소유자가{" "}
                <a href="/database">제어판</a>에서 확인한 뒤에 적용됩니다.
              </p>
              <Code language="json">{`{
  "collections": {
    "posts": { "read": "world", "write": "admin" },
    "guestbook": { "read": "world", "write": "create" },
    "profiles": { "read": "member", "write": "member", "unique": ["nick"] },
    "logs": {
      "read": "world", "write": "admin", "rules": "board",
      "indexes": ["board", "owner"]
    }
  }
}`}</Code>
              <p>
                <code>read</code>는 <code>admin</code>·<code>member</code>·
                <code>world</code>(누구나), <code>write</code>는 여기에{" "}
                <code>create</code>(누구나 생성만)를 더한 넷 중 하나이며 둘 다
                꼭 적어야 합니다. <code>unique</code>는 겹치면 안 되는 필드,{" "}
                <code>rules</code>는 <a href="#rules">컬렉션 규칙</a> 파일
                이름입니다. 다른 문서가 이미 가진 값을 쓰면{" "}
                <code>CONFLICT</code>로 실패하고,{" "}
                <code>error.details.unique</code>에 그 필드 이름이 담깁니다.
              </p>
              <p>
                <code>indexes</code>에는 자주 거르는 필드를 5개까지 적습니다.
                게시판별 목록(<code>board</code>)이나 내가 쓴 글(
                <code>owner</code>)처럼 그 필드로 거른 목록을
                최신순·오래된순으로 읽을 때, 문서가 많아도 모든 문서를 살피지
                않고 필요한 쪽만 읽습니다. 10만 개 중 스무 개를 찾는 데 수십
                밀리초 걸리던 것이 0.1밀리초 안쪽이 됩니다. 대신 그 컬렉션의
                쓰기가 조금 느려지고, <code>contains</code> 검색이나 다른 필드로
                정렬하는 데는 쓰이지 않습니다. 색인만 바꾸는 내용은 누구에게도
                무엇을 열지 않으므로 파일을 올리면 바로 적용됩니다.
              </p>
            </Section>

            <Section id="admin" title="05 · 관리자 로그인">
              <p>
                나루 홈페이지의 소유자가 로그인하면 홈페이지에 로그인할 수
                있습니다.
              </p>
              <ol className="list-decimal space-y-3 pl-6">
                <li>
                  제어판의 ‘웹사이트 관리자 로그인’에 관리자 페이지 주소(예:{" "}
                  <code>https://example.naru.pub/</code>)와 쓸 컬렉션을
                  등록합니다.
                </li>
                <li>
                  <code>naru.auth.signIn()</code>으로 로그인하고{" "}
                  <code>naru.auth.session()</code>으로 관리자 클라이언트를
                  받습니다.
                </li>
              </ol>
              <Code language="html">{`<button id="login">관리자 로그인</button>
<p id="auth-status"></p>
<script type="module">
  import { createNaru } from "https://naru.pub/sdk/1.1.0/naru.js";
  const naru = createNaru();
  const admin = await naru.auth.session();
  const login = document.querySelector("#login");
  login.hidden = !!admin;
  document.querySelector("#auth-status").textContent =
    admin ? "로그인되었습니다." : "글을 고치려면 로그인하세요.";
  login.onclick = () => naru.auth.signIn({ collections: ["posts", "drafts"] });
  // 다음 예제의 owner는 이 스크립트 안에서 사용하세요.
</script>`}</Code>
              <p>
                <code>session()</code>은 이 페이지에서 로그인한 적이 있으면
                관리자 클라이언트를, 아니면 null을 돌려줍니다. 로그인을 끝내려면{" "}
                <code>admin.signOut()</code>을 부르세요. 나루에 남은 이 페이지의
                로그인도 함께 끝납니다.
              </p>
              <Code>{`await admin.signOut();
location.reload();`}</Code>
            </Section>

            <Section id="members" title="06 · 회원과 서버 함수">
              <p>
                <strong>회원</strong>은 자기 나루 계정으로 이 사이트에 로그인한
                방문자입니다. 나루 계정이 있으면 누구나 회원이 될 수 있고, 미리
                등록할 것은 없습니다. 컬렉션의 읽기나 쓰기를 ‘회원’으로 설정하면
                회원만 읽거나 쓸 수 있습니다. SDK 1.1.0부터 쓸 수 있습니다.
              </p>
              <Code language="html">{`<button id="join">회원 로그인</button>
<script type="module">
  import { createNaru } from "https://naru.pub/sdk/1.1.0/naru.js";
  const naru = createNaru();
  const member = await naru.members.session();
  document.querySelector("#join").hidden = !!member;
  document.querySelector("#join").onclick = () => naru.members.signIn();
  if (member) {
    const board = member.collection("board");
    const post = await board.add({ title: "안녕하세요" });
    // post.createdBy === member.id: 누가 썼는지 서버가 기록합니다.
    await board.set(member.id, { nick: "나루" }); // 내 프로필
  }
</script>`}</Code>
              <p>
                <code>member.id</code>는 이 사이트에서만 쓰이는 회원 번호입니다.
                회원의 나루 아이디와 이메일은 사이트에 전달되지 않습니다. 회원이
                만든 문서에는 <code>createdBy</code>로 회원 번호가 남고, 회원은
                자기가 만든 문서와 자기 회원 번호를 ID로 쓰는 문서만 고칠 수
                있습니다. 닉네임처럼 회원마다 하나씩인 정보는{" "}
                <code>set(member.id, …)</code>로 저장하세요.
              </p>
              <p>
                회원 로그인은 사이트의 모든 페이지와 탭에서 유지되며, 7일 동안
                쓰지 않거나 로그인한 지 30일이 지나면, 또는 나루에서
                로그아웃하면 끝납니다. 페이지에서 끝내려면{" "}
                <code>member.signOut()</code>을 부르세요. 회원은{" "}
                <code>member.media.upload()</code>로 사이트의 미디어에 파일을
                올릴 수 있고, 쓰기와 업로드에는 회원마다 횟수 제한이 있습니다.
                관리자는 회원의 문서도 고치고 지울 수 있습니다.
              </p>
              <h3 className="font-bold">서버 함수</h3>
              <p>
                상점의 가격과 재고, 지갑의 잔액, 뽑기와 주사위처럼 회원의
                브라우저가 정하면 안 되는 규칙은 나루에서 돌아가는 함수로
                만듭니다. 사이트 파일의{" "}
                <code>_naru/functions/&lt;모듈&gt;.js</code>에서 함수를
                내보내고, 회원이{" "}
                <code>member.call(&quot;모듈/경로:함수&quot;, 인자)</code>로
                부릅니다. 함수는 한 트랜잭션 안에서 사이트 소유자의 권한으로
                모든 컬렉션을 읽고 쓰며, 오류가 나거나 한도를 넘으면 아무것도
                바꾸지 않습니다. 함수가 지키는 컬렉션(지갑 같은)은 쓰기를
                ‘관리자만’으로 두고 회원은 읽게만 하세요.
              </p>
              <Code language="javascript">{`// _naru/functions/shop.js
export async function buy(ctx, { item }) {
  const listing = await ctx.get("shop", item);
  const wallet = await ctx.get("wallets", ctx.member.id);
  if (!listing || listing.data.stock < 1) return { ok: false, reason: "품절" };
  if (wallet.data.balance < listing.data.price) return { ok: false, reason: "잔액 부족" };
  await ctx.set("wallets", ctx.member.id, { balance: wallet.data.balance - listing.data.price });
  await ctx.set("shop", item, { ...listing.data, stock: listing.data.stock - 1 });
  await ctx.add("inventory", { owner: ctx.member.id, item });
  return { ok: true };
}

// 페이지에서
const result = await member.call("shop:buy", { item: "sword" });
const boards = await member.call("community/boards:list");`}</Code>
              <p>
                공통 코드는 <code>_naru/modules/</code>에 두고 상대 경로로
                import하거나 다시 내보낼 수 있습니다. 경로에 <code>.js</code>를
                포함하세요. 번들 생성은 필요하지 않습니다. 패키지 이름과 URL,
                동적 import, 최상위 await는 지원하지 않습니다. 공통 모듈은
                회원이 직접 호출할 수 없습니다.
              </p>
              <Code language="javascript">{`// _naru/modules/prices.js
export const price = 10;

// _naru/functions/shop/buy.js
import { price } from "../../modules/prices.js";
export function quote() { return price; }

// 페이지에서
const price = await member.call("shop/buy:quote");`}</Code>
              <p>
                파일을 저장하거나 사이트를 설치하면 나루가 함수 파일의 리비전을
                만들고 적용합니다. import가 잘못되면 이전 리비전이 계속
                실행됩니다. 파일을 하나씩 올릴 때는 공통 모듈부터 올리세요. 한
                호출은 같은 리비전의 파일만 사용하며, 읽기 전용 호출에서는
                가져온 코드도 데이터를 쓸 수 없습니다.
              </p>
              <p>
                <code>ctx</code>에는 <code>member.id</code>, <code>now</code>,{" "}
                <code>get</code>·<code>getMany</code>·<code>list</code>·
                <code>count</code>·<code>add</code>·<code>set</code>·
                <code>delete</code>가 있습니다. 데이터베이스 메서드는 Promise를
                돌려주므로 <code>await</code>하세요. <code>await</code>하지 않은
                호출이 있으면 함수 전체가 실패하고 되돌려집니다. 함수는{" "}
                <code>async</code>여도 되고, 끝날 때까지 한 트랜잭션입니다.
                네트워크와 타이머는 쓸 수 없으며, 한 번 부를 때 데이터베이스
                작업 100번(쓰기 포함), 수십 밀리초, 메모리 32MiB까지 씁니다. ID
                100개를 한꺼번에 읽는 <code>getMany</code>도 <code>list</code>
                처럼 한 번으로 셉니다. 글 20개의 글쓴이를 하나씩{" "}
                <code>get</code>하지 말고 <code>getMany</code>로 한 번에
                읽으세요. 함수 파일은 사이트의 다른 파일처럼 누구나 볼 수 있으니
                비밀값을 넣지 마세요.
              </p>
              <p>
                읽기만 하는 함수는 모듈에서{" "}
                <code>export const readOnly = [&quot;함수&quot;]</code>로 알려
                주세요. 그 함수는 쓸 수 없고, 회원의 분당 호출 30번 대신 읽기
                120번에서 셉니다. 사이트 소유자도 <code>admin.call()</code>로
                같은 함수를 부를 수 있으며, 이때 <code>ctx.member</code>는 null,{" "}
                <code>ctx.owner</code>는 true입니다.
              </p>
              <h3 className="font-bold">방문자가 부르는 함수</h3>
              <p>
                로그인하지 않은 방문자에게도 열 함수는{" "}
                <code>export const visitors = [&quot;함수&quot;]</code>로
                알리세요. 방문자는 <code>naru.call()</code>로 부르고, 함수에서는{" "}
                <code>ctx.visitor</code>가 true, <code>ctx.member</code>가
                null입니다. 손님 글쓰기처럼 로그인 없이 쓰는 기능을 만들 때
                씁니다. 방문자의 호출은 주소마다 분당 쓰기 20번, 읽기
                60번까지입니다.
              </p>
              <Code language="javascript">{`// _naru/functions/guestbook.js
export const visitors = ["sign"];
export async function sign(ctx, { name, text }) {
  if (!text?.trim()) ctx.fail("INVALID_REQUEST", "내용을 입력해 주세요.");
  return (await ctx.add("guestbook", { name, text })).id;
}

// 페이지에서, 로그인 없이
await naru.call("guestbook:sign", { name: "손님", text: "안녕하세요" });`}</Code>
              <p>
                요청을 거절할 때는 <code>ctx.fail(코드, 메시지, 세부)</code>를
                부르세요. 함수가 한 일은 모두 되돌려지고, 페이지에서 받는{" "}
                <code>error.message</code>는 함수가 쓴 메시지 그대로라
                방문자에게 바로 보여 줄 수 있습니다. 세부는{" "}
                <code>error.details</code>로 전달되어, 페이지가 이유에 따라
                다르게 처리할 수 있습니다.
              </p>
              <Code language="javascript">{`// _naru/functions/points.js
export async function give(ctx, { to, amount }) {
  if (!Number.isInteger(amount) || amount < 1)
    ctx.fail("INVALID_REQUEST", "포인트는 1 이상의 정수로 보내 주세요.");
  const wallet = await ctx.get("wallets", ctx.member.id);
  if (wallet.data.points < amount)
    ctx.fail("CONFLICT", "포인트가 부족합니다.", { reason: "short" });
  // …
}

// 페이지에서
try {
  await member.call("points:give", { to, amount: 10 });
} catch (error) {
  status.textContent = error.message; // "포인트가 부족합니다."
}`}</Code>
              <Code language="javascript">{`// 함수에서: 커밋된 뒤에만 보냅니다.
ctx.notify(받는회원ID, { unread: true });
ctx.broadcast("board", { post: "new" });

// 페이지에서: 5초마다 묻는 대신 들으세요.
const live = member.live({
  topics: ["board"],
  onMessage(message) {
    if (message.type === "notice") showUnread();
    if (message.type === "topic") refreshBoard();
  },
});`}</Code>
              <p>
                <code>ctx.notify</code>는 그 회원에게만,{" "}
                <code>ctx.broadcast</code>는 주제를 듣는 모두에게 갑니다.
                로그인하지 않은 방문자는{" "}
                <code>naru.live(&#123; topics, onMessage &#125;)</code>로 같은
                주제를 듣습니다. 메시지는 저장되지 않으니 다시 연결되면 데이터를
                다시 읽으세요. 연결은 끊기면 스스로 다시 이어지고, 회원 승인이
                취소되면 닫힙니다.
              </p>
            </Section>

            <Section id="write" title="07 · 글 수정과 충돌 처리">
              <Table
                head={["호출", "동작"]}
                rows={[
                  [<code key="c">add(data)</code>, "새 ID로 문서를 만듭니다."],
                  [
                    <code key="c">set(id, data, {"{ condition }"})</code>,
                    "그 ID의 문서를 만들거나 통째로 바꿉니다. 필드를 합치지 않습니다.",
                  ],
                  [
                    <code key="c">delete(id, {"{ condition }"})</code>,
                    "문서를 지웁니다. 없는 문서를 지워도 성공합니다.",
                  ],
                ]}
              />
              <p>
                <code>condition</code>으로 덮어쓰기를 막을 수 있습니다.{" "}
                <code>{"{ revision }"}</code>은 읽은 뒤 바뀌지 않았을 때만,{" "}
                <code>{"{ absent: true }"}</code>는 아직 없는 문서일 때만
                저장하고, 아니면 <code>CONFLICT</code>로 실패합니다.
              </p>
              <Code>{`const post = await admin.collection("posts").get("hello");
try {
  await admin.collection("posts").set(
    "hello",
    { ...post.data, title: "새 제목" },
    { condition: { revision: post.revision } },
  );
} catch (error) {
  if (error.code !== "CONFLICT") throw error;
  alert("다른 곳에서 먼저 저장했습니다. 새로고침 후 다시 시도하세요.");
}`}</Code>
              <p>데이터에는 JSON 값만 넣으세요.</p>
              <h3 className="font-bold">여러 변경을 함께 저장하기</h3>
              <p>
                <code>admin.batch()</code>은 여러 컬렉션의 <code>set</code>·
                <code>delete</code>를 최대 100개까지 묶어, 원자적으로
                반영합니다. 각 변경의 condition도 함께 검사합니다. 미리 읽은
                값이 저절로 보호되는 것은 아니므로 고치는 문서의 revision을
                넘기세요. 결과는 쓴 순서대로, <code>set</code>은{" "}
                <code>{"{ id, revision, createdAt, updatedAt }"}</code>,{" "}
                <code>delete</code>는 <code>null</code>입니다.
              </p>
              <Code>{`const [saved] = await admin.batch([
  { collection: "posts", set: { id, data: post, condition: { absent: true } } },
  { collection: "drafts", delete: { id, condition: { revision: draft.revision } } },
]);
// saved.revision → 다음 저장의 condition`}</Code>
              <h3 className="font-bold">손님 글과 비밀번호</h3>
              <p>
                그누보드의 손님 글처럼, 방문자가 비밀번호를 걸어 글을 쓰고
                나중에 같은 비밀번호로 고치거나 지우게 하려면{" "}
                <a href="#members">방문자가 부르는 함수</a>를 씁니다.{" "}
                <code>ctx.add(컬렉션, 데이터, {"{ secret }"})</code>로 저장하면
                나루가 비밀번호를 해시로만 보관하고 돌려주지 않으며,{" "}
                <code>ctx.secretMatches(컬렉션, ID, 비밀번호)</code>로
                확인합니다. 컬렉션의 쓰기는 ‘관리자만’으로 두어 함수로만 바뀌게
                하세요.
              </p>
              <Code language="javascript">{`// _naru/functions/guestbook.js
export const visitors = ["write", "edit"];
export async function write(ctx, { name, text, password }) {
  return (await ctx.add("guestbook", { name, text }, { secret: password })).id;
}
export async function edit(ctx, { id, text, password }) {
  const post = await ctx.get("guestbook", id);
  if (!post || !(await ctx.secretMatches("guestbook", id, password)))
    ctx.fail("ACCESS_DENIED", "비밀번호가 맞지 않습니다.");
  await ctx.set("guestbook", id, { ...post.data, text });
}`}</Code>
              <p>
                한 번 부를 때 비밀번호는 세 번까지 확인할 수 있고, 한 글에 틀린
                비밀번호는 한 시간에 열 번까지입니다. 그 뒤에는 맞는 비밀번호도{" "}
                <code>RATE_LIMITED</code>로 실패하니, 짧은 비밀번호도 하나씩
                맞혀 볼 수 없습니다. SDK의 <code>add</code>·<code>set</code>·
                <code>delete</code>는 비밀번호를 받지 않습니다. ‘누구나
                생성만’인 컬렉션에서는 방문자가 글을 더할 수만 있고, 고치고
                지우는 것은 관리자만 할 수 있습니다.
              </p>
            </Section>

            <Section id="read" title="08 · 목록·검색·페이지">
              <Code>{`const posts = naru.collection("posts");

const post = await posts.get("hello");
// → { id, data, revision, createdAt, updatedAt }

const query = {
  filter: { category: "일상", date: { gte: "2026-09-01" } },
  sort: [["date", "desc"]],
};
const page = await posts.list({ ...query, size: 20 });
// → { documents, nextCursor }

if (page.nextCursor) {
  const next = await posts.list({ ...query, size: 20, after: page.nextCursor });
  console.log(next.documents);
}

// 조건에 맞는 문서 수
const total = await posts.count({ filter: query.filter });

// 끝까지 한 쪽씩 (nextCursor를 대신 따라갑니다)
for await (const { documents } of posts.pages({ ...query, size: 100 })) {
  console.log(documents);
}`}</Code>
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  <strong>filter</strong>: 최상위 필드를 값으로 비교하거나{" "}
                  <code>{"{ gt, gte, lt, lte }"}</code>로 범위를 찾습니다.
                  조건은 모두 만족해야 하며(AND) 최대 5개입니다. 날짜는{" "}
                  <code>&quot;2026-09-01&quot;</code>처럼 자리를 채운 문자열로
                  저장하면 범위로 찾을 수 있습니다.
                </li>
                <li>
                  <strong>sort</strong>: <code>[필드, 방향]</code>을 한두 개
                  넘깁니다. 생성·수정 시각은{" "}
                  <code>{'{ metadata: "createdAt" }'}</code>처럼 씁니다. 기본은
                  ID 오름차순입니다. 같은 날짜에서 최신 글을 먼저 보려면
                  <code>
                    {'[["date", "desc"], [{ metadata: "createdAt" }, "desc"]]'}
                  </code>
                  처럼 두 키를 씁니다. 문자열은 언어별 정렬 없이 유니코드
                  순서로, 숫자는 크기로 비교합니다. 오름차순에서 없는
                  값·null·배열·객체, 문자열, 숫자, 불리언 순입니다.
                </li>
                <li>
                  <strong>size</strong>: 한 번에 기본 50개, 최대 100개입니다.
                  다음 페이지는 같은 filter·sort에 <code>nextCursor</code>를{" "}
                  <code>after</code>로 넘기고, <code>nextCursor</code>가{" "}
                  <code>null</code>이면 끝입니다.{" "}
                  <code>includeTotal: true</code>면 전체 개수도 받습니다. 개수만
                  필요하면 <code>count()</code>를, 모든 쪽이 필요하면{" "}
                  <code>pages()</code>를 쓰세요. 누구나 쓸 수 있는 컬렉션은
                  끝까지 읽지 말고 필요한 만큼만 받으세요.
                </li>
              </ul>
              <h3 className="font-bold">검색과 여러 조건</h3>
              <p>
                <code>where</code>는 filter로 못 하는 조건을 적습니다.{" "}
                <code>all</code>(그리고)과 <code>any</code>(또는) 안에 비교를
                넣습니다. <code>contains</code>는 글자가 들어 있는 문자열 필드를
                찾으니, 게시판 검색에 쓰세요. 영문은 대소문자를 가리지 않습니다.
              </p>
              <Code>{`// 자유게시판에서 제목이나 본문에 "봄"이 들어간 글, 최신순
const found = await posts.list({
  filter: { board: "free" },
  where: {
    any: [
      { contains: ["title", "봄"] },
      { contains: ["text", "봄"] },
    ],
  },
  sort: [[{ metadata: "createdAt" }, "desc"]],
  size: 20,
});`}</Code>
              <Table
                head={["비교", "뜻"]}
                rows={[
                  [
                    <code key="c">{'{ eq: ["board", "free"] }'}</code>,
                    "같다 (ne는 다르다)",
                  ],
                  [
                    <code key="c">{'{ gte: ["level", 2] }'}</code>,
                    "크거나 같다 (gt·lt·lte도 있습니다)",
                  ],
                  [
                    <code key="c">
                      {'{ in: ["board", ["free", "notice"]] }'}
                    </code>,
                    "목록의 값 중 하나 (100개까지)",
                  ],
                  [
                    <code key="c">{'{ has: ["tags", "여행"] }'}</code>,
                    "배열 필드가 그 값을 담고 있다",
                  ],
                  [
                    <code key="c">{'{ contains: ["title", "봄"] }'}</code>,
                    "문자열 필드에 그 글자(1~100자)가 들어 있다",
                  ],
                  [
                    <code key="c">
                      {'{ eq: [{ metadata: "createdBy" }, member.id] }'}
                    </code>,
                    "그 회원이 만든 문서",
                  ],
                  [
                    <code key="c">
                      {
                        '{ gte: [{ metadata: "createdAt" }, "2026-10-01T00:00:00Z"] }'
                      }
                    </code>,
                    "그 시각 뒤에 만든 문서 (updatedAt도 됩니다)",
                  ],
                ]}
              />
              <p>
                <code>count()</code>와 서버 함수의 <code>ctx.list</code>·
                <code>ctx.count</code>도 같은 <code>where</code>를 받습니다.
                검색은 조건에 맞는 문서를 모두 살피므로, 문서가 아주 많은
                컬렉션에서는 <code>filter</code>로 게시판 같은 범위를 함께
                좁히세요.
              </p>
              <h3 className="font-bold">요청 취소하기</h3>
              <p>
                읽기, 쓰기, 업로드, 함수 호출은 옵션으로 <code>signal</code>을
                받습니다. 검색어를 바꿀 때 이전 검색을 멈추는 것처럼, 더 필요
                없는 요청은 <code>AbortController</code>로 취소하세요. 취소된
                요청은 <code>NaruError</code>가 아니라 브라우저의{" "}
                <code>AbortError</code>로 끝나며, 나루가 이미 받은 쓰기는
                되돌리지 않습니다.
              </p>
              <Code>{`let searching;
input.oninput = async () => {
  searching?.abort();
  searching = new AbortController();
  try {
    const page = await posts.list({
      where: { contains: ["title", input.value] },
      signal: searching.signal,
    });
    show(page.documents);
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  }
};`}</Code>
            </Section>

            <Section id="rules" title="09 · 컬렉션 규칙">
              <p>
                공개 범위는 컬렉션 전체에 하나입니다. ‘레벨 2 이상만 읽는
                게시판’, ‘비밀글은 글쓴이와 운영진만’처럼 문서마다 다른 권한이
                필요하면 <strong>컬렉션 규칙</strong>을 씁니다.{" "}
                <code>_naru/rules/&lt;이름&gt;.js</code>에서 두 함수를 내보내고,
                컬렉션의 <code>rules</code>에 그 이름을 적습니다. 그러면 회원과
                방문자가 SDK로 바로 읽고 쓰는 요청마다 나루가 규칙을 먼저
                부릅니다. 관리자는 규칙을 거치지 않습니다.
              </p>
              <Code language="javascript">{`// _naru/rules/board.js  (collections.json: "rules": "board")
export async function readable(ctx, { operation, id, filter }) {
  // 읽기: 이 회원에게 보일 문서의 조건을 돌려줍니다.
  // 글 하나(get)는 그 글의 게시판, 목록(list)은 filter의 게시판을 봅니다.
  const boardId =
    operation === "get" ? (await ctx.get("posts", id))?.data.board : filter.board;
  const board = boardId && (await ctx.get("boards", boardId));
  if (!board) return false; // 빈 목록
  if (board.data.membersOnly && !ctx.member)
    ctx.fail("AUTH_REQUIRED", "회원만 볼 수 있는 게시판입니다.");
  return {
    all: [
      { eq: ["board", board.id] },
      ctx.member
        ? { any: [{ ne: ["secret", true] }, { eq: ["owner", ctx.member.id] }] }
        : { ne: ["secret", true] },
    ],
  };
}

export async function canWrite(ctx, { operation, before, after }) {
  // 쓰기: 정확히 true를 돌려줘야 허락됩니다.
  if (!ctx.member) return false;
  if (operation === "create") return after.data.owner === ctx.member.id;
  if (before.data.owner !== ctx.member.id)
    ctx.fail("ACCESS_DENIED", "내가 쓴 글만 고칠 수 있습니다.");
  return true;
}`}</Code>
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  <code>readable</code>은 이 사람이 읽을 수 있는 문서를
                  고릅니다. 글 하나를 읽어도 되는지 예·아니오로 답하는 대신{" "}
                  <code>true</code>(모두), <code>false</code>(아무것도), 또는{" "}
                  <a href="#read">where와 같은 조건</a>을 돌려줍니다. 나루가 그
                  조건을 회원의 filter와 합쳐서 읽으므로, 숨긴 글 때문에 쪽이
                  짧아지거나 개수가 틀리지 않습니다. <code>false</code>는 오류가
                  아니라 빈 목록이 되니, 왜 안 보이는지 알려야 하면{" "}
                  <code>ctx.fail</code>을 쓰세요.
                </li>
                <li>
                  <code>canWrite</code>는 <code>create</code>·
                  <code>update</code>·<code>delete</code>마다 불리고, 정확히{" "}
                  <code>true</code>를 돌려줄 때만 허락합니다.{" "}
                  <code>return</code>을 빠뜨리면 거절됩니다. 그때 오류의 원인(
                  <code>error.cause.message</code>)에{" "}
                  <code>canWrite returned undefined</code>처럼 규칙 파일과 받은
                  값이 적혀 있습니다.
                </li>
                <li>
                  규칙은 <code>ctx.get</code>·<code>ctx.list</code>로 읽기만 할
                  수 있고, <code>_naru/modules/</code>의 공통 코드를 서버 함수와
                  함께 쓸 수 있습니다. 규칙 파일이 없거나 오류가 나면 회원과
                  방문자의 요청은 거절됩니다.
                </li>
                <li>
                  일부 필드만 숨기려면 <code>present</code>와{" "}
                  <code>queryable</code>도 내보냅니다. 자세한 내용은{" "}
                  <a href="/docs/sdk/1.1.0">SDK 레퍼런스</a>를 보세요.
                </li>
              </ul>
            </Section>

            <Section id="recipes" title="10 · 사용 예">
              <div className="grid gap-4 md:grid-cols-2">
                {[
                  {
                    title: "블로그 글 공개",
                    setup: "posts · 읽기 누구나 / 쓰기 관리자만",
                    code: `naru
  .collection("posts")
  .list({
    sort: [["date", "desc"]],
  });`,
                  },
                  {
                    title: "방명록",
                    setup: "guestbook · 읽기 누구나 / 쓰기 누구나 생성만",
                    code: `naru.collection("guestbook")
  .add({ name, message });`,
                  },
                  {
                    title: "비공개 문의 받기",
                    setup: "inquiries · 읽기 관리자만 / 쓰기 누구나 생성만",
                    code: `naru.collection("inquiries")
  .add({ email, message });`,
                  },
                  {
                    title: "초안 저장 후 공개",
                    setup: "drafts · 읽기 관리자만 / 쓰기 관리자만",
                    code: `admin.batch([
  { collection: "posts",
    set: { id, data, condition: { absent: true } } },
  { collection: "drafts",
    delete: { id, condition: { revision: draft.revision } } },
]);`,
                  },
                  {
                    title: "글에 이미지 붙이기",
                    setup: (
                      <>
                        <a href="/docs/1.1.0/media">미디어 라이브러리</a> ·
                        관리자 업로드
                      </>
                    ),
                    code: `const image =
  await admin.media.upload(file);
const posts = admin.collection("posts");
const post = await posts.get(id);
await posts.set(id, { ...post.data, cover: image.url },
  { condition: { revision: post.revision } });`,
                  },
                  {
                    title: "게시판 검색",
                    setup: "posts · 읽기 누구나 / 쓰기 관리자만",
                    code: `naru.collection("posts").list({
  filter: { board: "free" },
  where: { contains: ["title", word] },
});`,
                  },
                  {
                    title: "특정 글의 댓글",
                    setup: "comments · 읽기 누구나 / 쓰기 누구나 생성만",
                    code: `naru
  .collection("comments")
  .list({
    filter: { postId: "hello" },
  });`,
                  },
                ].map((recipe) => (
                  <section
                    key={recipe.title}
                    className="min-w-0 space-y-3 rounded-lg border p-5"
                  >
                    <h3 className="font-bold">{recipe.title}</h3>
                    <p className="text-sm text-muted-foreground">
                      {recipe.setup}
                    </p>
                    <pre className="overflow-x-auto rounded bg-muted px-3 py-2 text-xs leading-5">
                      <code>{recipe.code}</code>
                    </pre>
                  </section>
                ))}
              </div>
              <p>
                바로 시작할 수 있는 사이트가 필요하면 게시판에서{" "}
                <Link href="/board?kind=template&database=1">
                  데이터베이스를 쓰는 템플릿
                </Link>
                을 둘러보세요.
              </p>
            </Section>

            <Section id="errors" title="11 · 한도와 오류">
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  사이트당 컬렉션 100개, 문서 100,000개, 데이터 100 MiB. 요청
                  하나는 64 KiB까지입니다.
                </li>
                <li>
                  방문자의 <code>add</code>는 분당 횟수가 제한됩니다.
                </li>
                <li>관리자 로그인 페이지는 사이트당 20개까지 등록합니다.</li>
              </ul>
              <p>
                실패하면 <code>NaruError</code>를 던집니다. 방문자에게는{" "}
                <code>error.message</code>를 보여 주세요. 나루의 오류는 한국어로
                적혀 있고, 서버 함수나 규칙의 <code>ctx.fail</code>은 그 메시지
                그대로입니다. 무엇이 왜 실패했는지 개발자를 위한 자세한 설명은{" "}
                <code>error.cause.message</code>에 영어로 있으니, 막히면
                콘솔에서 확인하세요. 처리를 나눌 때는 <code>code</code>를
                쓰세요.
              </p>
              <Table
                head={["code", "뜻"]}
                rows={[
                  ["NOT_FOUND", "문서, 컬렉션 또는 사이트가 없습니다."],
                  [
                    "ACCESS_DENIED",
                    "공개 범위, 등록된 컬렉션 또는 컬렉션 규칙이 허용하지 않습니다.",
                  ],
                  [
                    "AUTH_REQUIRED",
                    "관리자 권한이 만료되었습니다. 다시 로그인하세요.",
                  ],
                  [
                    "CONFLICT",
                    "condition이 맞지 않거나, unique 필드의 값이 이미 쓰이고 있습니다(error.details.unique).",
                  ],
                  [
                    "QUOTA_EXCEEDED",
                    "데이터나 미디어 저장 공간이 가득 찼습니다.",
                  ],
                  [
                    "RATE_LIMITED",
                    "요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
                  ],
                  [
                    "INVALID_REQUEST",
                    "이름, 필터, 크기 등 요청 형식이 잘못되었습니다.",
                  ],
                  ["UNAVAILABLE", "일시적인 오류입니다."],
                ].map(([code, meaning]) => [
                  <code key="c">{code}</code>,
                  meaning,
                ])}
              />
              <Code>{`try {
  await naru.collection("guestbook").add({ message });
} catch (error) {
  status.textContent = error.message; // 예: "요청이 너무 많습니다. 잠시 뒤에 다시 해 주세요."
  console.error(error.cause?.message); // 개발자를 위한 자세한 설명
}`}</Code>
            </Section>
          </article>
        </div>
      </div>
    </div>
  );
}
