import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import Code from "../../Code";
import DocsNav from "../../DocsNav";

export const metadata: Metadata = {
  title: "데이터베이스 사용 안내 | 나루",
  description:
    "나루 제어판과 웹 SDK로 블로그, 방명록, 회원 게시판과 관리자 글쓰기를 만드는 방법",
};

const sections = [
  ["start", "01 · 빠른 시작"],
  ["ideas", "02 · 나루가 일하는 방식"],
  ["php", "03 · PHP와 견주어 보기"],
  ["collections", "04 · 컬렉션과 공개 범위"],
  ["admin", "05 · 관리자 로그인"],
  ["write", "06 · 글 수정과 충돌 처리"],
  ["read", "07 · 목록과 페이지 나누기"],
  ["members", "08 · 회원"],
  ["code", "09 · 사이트 코드: 테이블·쿼리·뮤테이션"],
  ["live", "10 · 실시간 쿼리"],
  ["routes", "11 · 라우트"],
  ["recipes", "12 · 사용 예"],
  ["errors", "13 · 한도와 오류"],
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
  import { createNaru } from "https://sdk.naru.pub/sdk/1.1.0/naru.js";

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
  import { createNaru } from "https://sdk.naru.pub/sdk/1.1.0/naru.js";
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
                있는지는 나루와 나루에서 도는 사이트 코드가 정합니다. 가격,
                잔액, 권한, 주사위처럼 속이면 안 되는 것은 모두 그곳에서
                정하세요.
              </p>
              <h3 className="font-bold">데이터를 두는 곳은 두 가지입니다</h3>
              <Table
                head={["", "컬렉션", "사이트 테이블"]}
                rows={[
                  [
                    "모양",
                    "문서마다 JSON 하나",
                    <>
                      <code>_naru/migrations/</code>의 SQL로 만든 SQLite 테이블
                    </>,
                  ],
                  [
                    "읽고 쓰는 길",
                    <>
                      페이지가 SDK의 <code>collection(이름)</code>으로 바로
                    </>,
                    <>
                      사이트의 <a href="#code">쿼리와 뮤테이션</a>을 거쳐서만
                    </>,
                  ],
                  [
                    "누가 정하나",
                    "컬렉션마다 하나의 공개 범위",
                    "사이트 코드가 부른 사람을 보고 정합니다",
                  ],
                  [
                    "알맞은 곳",
                    "블로그 글, 방명록, 문의함, 설정",
                    "회원 게시판, 댓글, 포인트, 상점처럼 규칙이 있는 데이터",
                  ],
                ]}
              />
              <p>
                둘은 서로 섞이지 않습니다. 사이트 코드의 SQL은 컬렉션을 읽을 수
                없고, 컬렉션의 SDK는 테이블을 읽을 수 없습니다. 한 사이트에서
                둘을 함께 써도 됩니다.
              </p>
              <h3 className="font-bold">세 사람</h3>
              <p>
                요청하는 사람은 셋입니다. 로그인하지 않은{" "}
                <strong>방문자</strong>, 자기 나루 계정으로 이 사이트에 로그인한{" "}
                <strong>회원</strong>, 사이트의 <strong>소유자</strong>입니다.
                방문자와 소유자는 컬렉션을 공개 범위에 따라 읽고 씁니다. 회원은
                컬렉션에 따로 권한이 없고, 사이트 코드를 부릅니다. 셋 모두 같은{" "}
                <code>query(이름, 인자)</code>와 <code>mutate(이름, 인자)</code>
                를 부르고, 사이트 코드는 <code>ctx.member</code>·
                <code>ctx.owner</code>·<code>ctx.visitor</code>로 누가 불렀는지
                압니다.
              </p>
              <h3 className="font-bold">지키는 곳</h3>
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
                    "사람마다, 글마다 다른 권한",
                    <a key="a" href="#code">
                      쿼리와 뮤테이션
                    </a>,
                    "회원은 자기 글만 고치고, 운영진은 모든 글을 지운다",
                  ],
                  [
                    "여러 행을 함께 바꾸는 일",
                    <a key="a" href="#code">
                      뮤테이션
                    </a>,
                    "물건을 사면 잔액과 재고와 인벤토리가 한꺼번에 바뀐다",
                  ],
                ]}
              />
              <p>
                뮤테이션 한 번은 트랜잭션 하나라서, 다 되거나 아무것도 바뀌지
                않습니다. 중간에 멈춘 구매처럼 반쯤 된 상태는 생기지 않습니다.
              </p>
              <h3 className="font-bold">사이트 파일이 곧 설정입니다</h3>
              <p>
                컬렉션, 테이블, 쿼리, 뮤테이션, 라우트는 사이트의{" "}
                <code>_naru/</code> 폴더에 둡니다. 사이트와 함께 GitHub에
                올라가고, 템플릿을 설치하면 함께 복사되며, 파일을 올리면 바로
                적용됩니다. 제어판에서 하나씩 누르지 않아도 사이트가 스스로
                필요한 것을 갖춥니다. 다만 이미 있는 컬렉션의 공개 범위를 바꾸는
                내용은 소유자가 제어판에서 확인한 뒤에 적용됩니다. 이 파일들은
                다른 사이트 파일처럼 누구나 볼 수 있으니 비밀값을 넣지 마세요.
              </p>
              <h3 className="font-bold">작고 빠르게, 정해진 한도 안에서</h3>
              <p>
                모든 사이트가 서버를 나눠 쓰므로 사이트 코드에는 한도가
                있습니다. 한 번에 데이터베이스 작업 100번, 수십 밀리초입니다.
                한도는 실수를 일찍 드러냅니다. 끝없는 반복이나 한 번에 모든 글을
                읽는 코드는 실패하고, 바꾼 것은 되돌려집니다. 많은 글을 다룰
                때는 색인을 만들고 <code>LIMIT</code>로 필요한 만큼만 읽으세요.
              </p>
              <h3 className="font-bold">오류는 방문자에게 보여 줄 수 있게</h3>
              <p>
                실패하면 <code>error.message</code>를 그대로 화면에 띄워도
                되도록, 나루의 오류는 한국어로, 사이트 코드의{" "}
                <code>ctx.fail</code>은 사이트가 쓴 말 그대로 옵니다. 무엇이 왜
                실패했는지 개발자를 위한 설명은 <code>error.cause.message</code>
                에, 처리를 나눌 값은 <code>error.code</code>와{" "}
                <code>error.details</code>에 있습니다.
              </p>
            </Section>

            <Section id="php" title="03 · PHP와 견주어 보기">
              <p>
                그누보드나 PHP로 게시판을 만들어 봤다면, 나루에서도 하는 일은
                같습니다. PHP 파일이 하던 일은 사이트 코드가 맡고, 페이지의
                스크립트가 그것을 이름으로 부릅니다. SQL도 그대로 씁니다.
              </p>
              <Table
                head={["PHP에서", "나루에서"]}
                rows={[
                  [
                    <code key="c">CREATE TABLE</code>,
                    <>
                      <a href="#code">
                        <code>_naru/migrations/0001_posts.sql</code>
                      </a>
                      에 같은 SQL을 적습니다.
                    </>,
                  ],
                  [
                    <code key="c">
                      SELECT … WHERE board = &apos;free&apos;
                    </code>,
                    <>
                      쿼리 안에서{" "}
                      <code>{"ctx.sql`SELECT … WHERE board = ${board}`"}</code>
                    </>,
                  ],
                  [
                    <code key="c">WHERE title LIKE &apos;%봄%&apos;</code>,
                    "쿼리 안에서 같은 LIKE를 씁니다.",
                  ],
                  [
                    <code key="c">LIMIT 20 OFFSET 40</code>,
                    <>
                      쿼리 안의 <code>LIMIT</code>. 컬렉션은 <code>size</code>와{" "}
                      <code>nextCursor</code>로 다음 쪽을 읽습니다.
                    </>,
                  ],
                  [
                    <code key="c">INSERT</code>,
                    <>
                      뮤테이션 안의 <code>{"ctx.sql`INSERT …`"}</code>. 컬렉션은{" "}
                      <code>add(data)</code>
                    </>,
                  ],
                  [
                    <code key="c">$_SESSION[&apos;mb_id&apos;]</code>,
                    <>
                      <a href="#members">회원 로그인</a> 뒤 사이트 코드의{" "}
                      <code>ctx.member.id</code>
                    </>,
                  ],
                  [
                    <code key="c">$member[&apos;mb_level&apos;]</code>,
                    <>
                      회원의 역할, <code>ctx.member.roles</code>
                    </>,
                  ],
                  [
                    <code key="c">alert(&apos;권한이 없습니다.&apos;)</code>,
                    <>
                      사이트 코드의 <code>ctx.fail(코드, 메시지)</code>.
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
                    <code key="n">_naru/migrations/</code>,
                    <>
                      <code>install.sql</code>과 업데이트마다 돌리던 SQL
                    </>,
                    "파일을 올리면 나루가 차례대로 한 번씩 적용합니다. 적용된 파일은 고치지 않고 새 파일을 더합니다.",
                  ],
                  [
                    <code key="n">_naru/queries/</code>,
                    <>
                      <code>list.php</code>·<code>view.php</code>처럼 읽는 파일
                    </>,
                    <>
                      주소 대신 이름으로 부릅니다:{" "}
                      <code>naru.query(&quot;board:recent&quot;)</code>
                    </>,
                  ],
                  [
                    <code key="n">_naru/mutations/</code>,
                    <>
                      폼이 보내는 <code>write_update.php</code> 같은 파일
                    </>,
                    <>
                      <code>member.mutate(&quot;board:write&quot;, 인자)</code>.
                      한 번이 트랜잭션 하나입니다.
                    </>,
                  ],
                  [
                    <code key="n">_naru/routes/</code>,
                    <>
                      <code>board.php?id=3</code>처럼 서버가 그리는 페이지
                    </>,
                    "필요할 때만 씁니다. 대부분의 페이지는 정적 HTML과 스크립트로 충분합니다.",
                  ],
                  [
                    <code key="n">_naru/modules/</code>,
                    <>
                      <code>include &apos;lib/common.lib.php&apos;</code>로 불러
                      쓰던 <code>lib/</code>
                    </>,
                    "사이트 코드가 import합니다. 페이지에서 직접 부를 수는 없습니다.",
                  ],
                  [
                    <code key="n">_naru/collections.json</code>,
                    "—",
                    "SQL 없이 JSON 문서를 모으는 컬렉션을 정합니다.",
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
                    "누구나 생성·덮어쓰기·삭제",
                    "누구나 모든 문서를 바꾸고 지울 수 있습니다. 대부분은 필요 없습니다.",
                  ],
                ]}
              />
              <p>
                관리자는 <a href="#admin">로그인</a>하면 등록한 컬렉션을 공개
                범위와 상관없이 읽고 쓸 수 있습니다. 공개 읽기 컬렉션의 문서는
                누구나 읽을 수 있으니, 비공개로 둘 데이터는 ‘관리자만’ 읽는
                컬렉션에 따로 저장하세요. 회원만 읽거나 글쓴이만 고치는 데이터는
                컬렉션 대신 <a href="#code">사이트 테이블</a>에 두세요.
              </p>
              <h3 className="font-bold">파일로 컬렉션 정하기</h3>
              <p>
                사이트 파일에 <code>_naru/collections.json</code>을 두면, 파일을
                올릴 때 나루가 없는 컬렉션을 만듭니다. 템플릿을 설치한 사람도
                제어판에서 하나씩 만들 필요가 없습니다. 이미 있는 컬렉션의 공개
                범위나 unique 필드를 바꾸는 내용은 소유자가{" "}
                <a href="/database">제어판</a>에서 확인한 뒤에 적용됩니다.
              </p>
              <Code language="json">{`{
  "collections": {
    "posts": { "read": "world", "write": "admin", "indexes": ["category"] },
    "guestbook": { "read": "world", "write": "create" },
    "subscribers": { "read": "admin", "write": "create", "unique": ["email"] }
  }
}`}</Code>
              <p>
                <code>read</code>는 <code>admin</code>·<code>world</code>
                (누구나), <code>write</code>는 여기에 <code>create</code>(누구나
                생성만)를 더한 셋 중 하나이며 둘 다 꼭 적어야 합니다.{" "}
                <code>unique</code>는 겹치면 안 되는 필드입니다. 다른 문서가
                이미 가진 값을 쓰면 <code>CONFLICT</code>로 실패하고,{" "}
                <code>error.details.unique</code>에 그 필드 이름이 담깁니다.
              </p>
              <p>
                <code>indexes</code>에는 자주 거르는 필드를 5개까지 적습니다.
                분류별 목록(<code>category</code>)처럼 그 필드로 거른 목록을
                최신순·오래된순으로 읽을 때, 문서가 많아도 모든 문서를 살피지
                않고 필요한 쪽만 읽습니다. 10만 개 중 스무 개를 찾는 데 수십
                밀리초 걸리던 것이 0.1밀리초 안쪽이 됩니다. 대신 그 컬렉션의
                쓰기가 조금 느려지고, 다른 필드로 정렬하는 데는 쓰이지 않습니다.
                색인만 바꾸는 내용은 누구에게도 무엇을 열지 않으므로 파일을
                올리면 바로 적용됩니다.
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
  import { createNaru } from "https://sdk.naru.pub/sdk/1.1.0/naru.js";
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
              <p>
                관리자도 <code>admin.query()</code>·<code>admin.mutate()</code>
                로 사이트 코드를 부릅니다. 이때 <code>ctx.owner</code>는 true,{" "}
                <code>ctx.member</code>는 null이고, 소유자의 호출은 횟수 제한에
                세지 않습니다. 컬렉션은 쓰지 않고 사이트 코드로만 관리하는
                페이지라면 <code>collections</code> 없이{" "}
                <code>naru.auth.signIn()</code>으로 로그인하세요.
              </p>
            </Section>

            <Section id="write" title="06 · 글 수정과 충돌 처리">
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
            </Section>

            <Section id="read" title="07 · 목록과 페이지 나누기">
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
                <li>
                  <strong>쪽 번호</strong>: 몇 번째부터 건너뛰는 offset은
                  없습니다. 3쪽을 보이려면 1쪽부터 <code>nextCursor</code>를
                  따라가고, 받은 커서를 쪽 번호와 함께 저장해 두면 앞뒤로 오갈
                  때 다시 읽지 않습니다.
                </li>
              </ul>
              <p>
                글자가 들어 있는 글을 찾는 검색이나 여러 조건을 또는(OR)으로
                묶는 목록은 컬렉션으로 할 수 없습니다. 그런 데이터는{" "}
                <a href="#code">사이트 테이블</a>에 두고 쿼리에서 SQL로
                찾으세요.
              </p>
              <h3 className="font-bold">요청 취소하기</h3>
              <p>
                읽기, 쓰기, 업로드, 쿼리와 뮤테이션은 옵션으로{" "}
                <code>signal</code>을 받습니다. 검색어를 바꿀 때 이전 검색을
                멈추는 것처럼, 더 필요 없는 요청은 <code>AbortController</code>
                로 취소하세요. 취소된 요청은 <code>NaruError</code>가 아니라
                브라우저의 <code>AbortError</code>로 끝나며, 나루가 이미 받은
                쓰기는 되돌리지 않습니다.
              </p>
              <Code>{`let searching;
input.oninput = async () => {
  searching?.abort();
  searching = new AbortController();
  try {
    const found = await naru.query(
      "board:search",
      { word: input.value },
      { signal: searching.signal },
    );
    show(found);
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  }
};`}</Code>
            </Section>

            <Section id="members" title="08 · 회원">
              <p>
                <strong>회원</strong>은 자기 나루 계정으로 이 사이트에 로그인한
                방문자입니다. 미리 등록할 것은 없고, 페이지에서{" "}
                <code>naru.members.signIn()</code>을 부르면 나루에서 로그인하고
                (계정이 없으면 만들고) 이 페이지로 돌아옵니다.{" "}
                <code>naru.members.session()</code>은 로그인한 회원을, 아니면
                null을 돌려줍니다. SDK 1.1.0부터 쓸 수 있습니다.
              </p>
              <Code language="html">{`<button id="join">회원 로그인</button>
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1.1.0/naru.js";
  const naru = createNaru();
  const member = await naru.members.session();
  document.querySelector("#join").hidden = !!member;
  document.querySelector("#join").onclick = () => naru.members.signIn();
  if (member) {
    const id = await member.mutate("board:write", {
      title: "안녕하세요",
      body: "처음 인사드립니다.",
    });
    // 사이트 코드에서는 ctx.member.id === member.id
  }
</script>`}</Code>
              <p>
                <code>member.id</code>는 이 사이트에서만 쓰이는 회원 번호이고,
                방문할 때마다 같습니다. 회원의 나루 아이디와 이메일은 사이트에
                전달되지 않습니다. 회원이 할 수 있는 일은 사이트 코드가
                정합니다. 회원은 <code>member.query()</code>·
                <code>member.mutate()</code>로 <a href="#code">사이트 코드</a>를
                부르고, <code>member.subscribe()</code>로{" "}
                <a href="#live">실시간 쿼리</a>를 듣습니다. 그러면 사이트
                코드에서 <code>ctx.member</code>가{" "}
                <code>{"{ id, roles }"}</code>입니다. 회원은 컬렉션에 따로
                권한이 없으니, 컬렉션은 방문자로서{" "}
                <code>naru.collection()</code>
                으로 읽습니다.
              </p>
              <p>
                회원 로그인은 사이트의 모든 페이지와 탭에서 유지되며, 7일 동안
                쓰지 않거나 로그인한 지 30일이 지나면, 또는 나루에서
                로그아웃하면 끝납니다. 페이지에서 끝내려면{" "}
                <code>member.signOut()</code>을 부르세요. 회원은{" "}
                <code>member.media.upload()</code>로 사이트의{" "}
                <a href="/docs/1.1.0/media">미디어</a>에 파일을 올리고{" "}
                <code>member.media.delete()</code>로 자기가 올린 파일을 지울 수
                있습니다. 업로드는 회원마다 한 시간에 30개까지입니다.
              </p>
              <h3 className="font-bold">가입과 승인</h3>
              <p>
                <a href="/database">제어판</a>의 ‘사이트 회원’에서 신규 가입을
                ‘누구나 가입’, ‘운영자 승인 후 이용’, ‘신규 가입 중단’ 중에
                고르고, 이메일을 인증한 계정만 받을지 정합니다. 회원 목록에서
                회원을 승인하거나 차단할 수 있습니다. 승인을 기다리거나 차단된
                회원의 요청은 <code>ACCESS_DENIED</code>로 실패하고,{" "}
                <code>error.details.membership</code>이{" "}
                <code>&quot;pending&quot;</code> 또는{" "}
                <code>&quot;banned&quot;</code>이니 페이지에서 알맞은 안내를
                보여 주세요. 로그인은 남아 있어서, 승인되면 다시 로그인하지
                않아도 됩니다. 사이트에 회원으로 가입하려면 그 나루 계정에 후원
                플랜이 있어야 합니다.
              </p>
              <h3 className="font-bold">역할</h3>
              <p>
                <strong>역할</strong>은 사이트가 회원에게 붙이는 이름입니다(예:{" "}
                <code>staff</code>, <code>writer</code>). 회원마다 16개까지 붙일
                수 있고, 제어판의 회원 목록이나 뮤테이션의{" "}
                <code>ctx.setRoles(회원ID, 역할)</code>로 정합니다. 사이트
                코드는 부른 회원의 역할을 <code>ctx.member.roles</code>로, 다른
                회원의 역할을 <code>ctx.rolesOf([회원ID, …])</code>로 읽습니다.
                그누보드의 회원 레벨이나 운영진 표시를 역할로 만드세요.
              </p>
              <Code>{`// _naru/mutations/staff.js
export async function promote(ctx, { member }) {
  if (!ctx.owner && !ctx.member?.roles.includes("staff"))
    ctx.fail("ACCESS_DENIED", "운영진만 할 수 있습니다.");
  const roles = (await ctx.rolesOf([member]))[member];
  await ctx.setRoles(member, [...roles, "writer"]);
}`}</Code>
            </Section>

            <Section id="code" title="09 · 사이트 코드: 테이블·쿼리·뮤테이션">
              <p>
                회원 게시판, 댓글, 포인트처럼 누가 무엇을 할 수 있는지 사이트가
                정해야 하는 데이터는 사이트의 SQLite 테이블에 두고, 나루에서
                도는 사이트의 코드로 읽고 씁니다. 세 가지 파일을 씁니다.
              </p>
              <Table
                head={["파일", "하는 일", "부르는 법"]}
                rows={[
                  [
                    <code key="f">_naru/migrations/*.sql</code>,
                    "테이블과 색인을 만들고 바꿉니다.",
                    "파일을 올리면 나루가 한 번씩 적용합니다.",
                  ],
                  [
                    <code key="f">_naru/queries/경로.js</code>,
                    "테이블을 읽어 돌려줍니다. 쓸 수 없습니다.",
                    <code key="c">
                      naru.query(&quot;경로:이름&quot;, 인자)
                    </code>,
                  ],
                  [
                    <code key="f">_naru/mutations/경로.js</code>,
                    "검사하고, 쓰고, 결과를 돌려줍니다. 한 번이 트랜잭션 하나입니다.",
                    <code key="c">
                      member.mutate(&quot;경로:이름&quot;, 인자)
                    </code>,
                  ],
                ]}
              />
              <h3 className="font-bold">테이블 만들기: 마이그레이션</h3>
              <p>
                <code>_naru/migrations/</code>에 <code>.sql</code> 파일을
                둡니다. 나루는 파일을 올릴 때 아직 적용하지 않은 마이그레이션을
                이름 순서대로 한 번씩 적용하고, 그 직전의 데이터를 복원 지점으로
                남겨 둡니다. 이름 앞에 <code>0001_</code>처럼 자리를 채운 번호를
                붙이세요.
              </p>
              <Code language="sql">{`-- _naru/migrations/0001_posts.sql
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  author TEXT NOT NULL,       -- 회원 번호 (ctx.member.id)
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL -- ctx.now (밀리초)
);
CREATE INDEX posts_author ON posts (author);`}</Code>
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  한 번 적용된 파일은 고치거나 지울 수 없습니다. 열을 더하거나
                  바꾸려면 <code>0002_body_format.sql</code>처럼 새 파일을
                  더하세요. 새 파일의 이름은 이미 적용된 파일보다 뒤에 와야
                  합니다.
                </li>
                <li>
                  <code>CREATE</code>·<code>ALTER</code>·<code>DROP</code>{" "}
                  (TABLE·INDEX·VIEW)과 데이터를 옮기는 <code>INSERT</code>·
                  <code>UPDATE</code>·<code>DELETE</code>를 쓸 수 있습니다. 전문
                  검색 테이블은{" "}
                  <code>
                    CREATE VIRTUAL TABLE search USING fts5(title, body,
                    tokenize=&apos;trigram&apos;)
                  </code>
                  로 만들고 <code>MATCH</code>나 <code>LIKE</code>로 찾습니다.
                  trigram은 한국어도 세 글자 이상이면 찾습니다. 내용을 직접 갖지
                  않는 전문 검색 테이블(<code>content=&apos;&apos;</code>), 다른
                  가상 테이블, 트리거, 임시 테이블은 쓸 수 없습니다.
                </li>
                <li>
                  마이그레이션 하나라도 실패하면 그 릴리스 전체가 거절되고
                  아무것도 바뀌지 않습니다. 이전의 테이블과 코드가 그대로
                  쓰입니다. 오류를 고친 파일을 다시 올리세요.
                </li>
                <li>
                  적용된 마이그레이션이 데이터를 잘못 바꿨다면 제어판의
                  데이터베이스 → 복원 지점에서 그 릴리스 직전으로 복원할 수
                  있습니다. 컬렉션과 문서, 테이블과 행, 적용된 마이그레이션
                  기록, 회원 역할이 그 시점으로 돌아가고 그 뒤의 변경은
                  사라집니다. 복원 직전 상태도 복원 지점으로 남으니 되돌릴 수
                  있습니다. 사이트 코드는 지금 릴리스 그대로라서, 복원 지점에
                  없던 마이그레이션은 다음에 <code>_naru</code> 파일을 올릴 때
                  다시 적용됩니다. 그 전에 그 마이그레이션을 고치거나 지우세요.
                  복원 지점은 만든 때부터 7일 동안 보관하고, 그 뒤에 삭제합니다.
                </li>
                <li>
                  나루가 쓰는 이름(<code>collections</code>,{" "}
                  <code>documents</code>, <code>meta</code>, <code>usage</code>,{" "}
                  <code>rate_limits</code>, <code>media_refs</code>와{" "}
                  <code>_naru</code>·<code>sqlite_</code>로 시작하는 이름)은
                  테이블 이름으로 쓸 수 없습니다.
                </li>
              </ul>
              <h3 className="font-bold">읽기: 쿼리</h3>
              <p>
                <code>_naru/queries/board.js</code>에서 내보낸 함수는{" "}
                <code>&quot;board:이름&quot;</code>으로,{" "}
                <code>_naru/queries/community/board.js</code>의 함수는{" "}
                <code>&quot;community/board:이름&quot;</code>으로 부릅니다.
                함수는 <code>ctx</code>와 페이지가 넘긴 인자를 받고, 돌려준 JSON
                값이 페이지에 그대로 갑니다.
              </p>
              <Code>{`// _naru/queries/board.js
export async function recent(ctx, { before } = {}) {
  const { rows } = await ctx.sql\`
    SELECT id, author, title, created_at FROM posts
    WHERE id < \${before ?? Number.MAX_SAFE_INTEGER}
    ORDER BY id DESC LIMIT 20\`;
  return rows;
}

export async function post(ctx, { id }) {
  const [post] = (await ctx.sql\`SELECT * FROM posts WHERE id = \${id}\`).rows;
  if (!post) ctx.fail("NOT_FOUND", "글이 없거나 지워졌습니다.");
  return post;
}

// 페이지에서
const posts = await naru.query("board:recent");
const more = await naru.query("board:recent", { before: posts.at(-1).id });`}</Code>
              <p>
                쿼리는 누구나 부를 수 있습니다. 회원만 읽게 하려면{" "}
                <code>ctx.member</code>를 확인하고, 돌려주면 안 되는 열(비밀번호
                해시 같은)은 고르지 마세요. 쿼리는 테이블을 쓸 수 없고, 나루
                서버가 잠시 대기 서버로 넘어가 있는 동안에도 답합니다.
              </p>
              <h3 className="font-bold">쓰기: 뮤테이션</h3>
              <Code>{`// _naru/mutations/board.js
export async function write(ctx, { title, body }) {
  if (!ctx.member) ctx.fail("AUTH_REQUIRED", "회원만 글을 쓸 수 있습니다.");
  if (typeof title !== "string" || !title.trim())
    ctx.fail("INVALID_REQUEST", "제목을 입력해 주세요.");
  const { rows } = await ctx.sql\`
    INSERT INTO posts (author, title, body, created_at)
    VALUES (\${ctx.member.id}, \${title}, \${String(body)}, \${ctx.now})
    RETURNING id\`;
  return rows[0].id;
}

export async function remove(ctx, { id }) {
  const [post] = (await ctx.sql\`SELECT author FROM posts WHERE id = \${id}\`).rows;
  if (!post) return;
  const mine = post.author === ctx.member?.id;
  if (!mine && !ctx.owner && !ctx.member?.roles.includes("staff"))
    ctx.fail("ACCESS_DENIED", "내가 쓴 글만 지울 수 있습니다.");
  await ctx.sql\`DELETE FROM posts WHERE id = \${id}\`;
}

// 페이지에서
try {
  await member.mutate("board:remove", { id });
} catch (error) {
  status.textContent = error.message; // "내가 쓴 글만 지울 수 있습니다."
}`}</Code>
              <p>
                뮤테이션 한 번은 트랜잭션 하나입니다. 함수가 값을 돌려주면 쓴
                것이 모두 저장되고, 오류가 나거나 <code>ctx.fail</code>을
                부르거나 한도를 넘으면 아무것도 바뀌지 않습니다. 요청을 거절할
                때는 <code>ctx.fail(코드, 메시지, 세부)</code>를 부르세요.
                페이지가 받는 <code>error.message</code>는 사이트가 쓴 메시지
                그대로(1~1000자)라 방문자에게 바로 보여 줄 수 있고, 세부(4 KiB
                이하의 JSON)는 <code>error.details</code>로 전달되어 페이지가
                이유에 따라 다르게 처리할 수 있습니다.
              </p>
              <h3 className="font-bold">누가 불렀나</h3>
              <Table
                head={["페이지에서", "ctx.member", "ctx.owner", "ctx.visitor"]}
                rows={[
                  [
                    <code key="c">naru.query()·naru.mutate()</code>,
                    "null",
                    "false",
                    "true",
                  ],
                  [
                    <code key="c">member.query()·member.mutate()</code>,
                    <code key="m">{"{ id, roles }"}</code>,
                    "false",
                    "false",
                  ],
                  [
                    <code key="c">admin.query()·admin.mutate()</code>,
                    "null",
                    "true",
                    "false",
                  ],
                ]}
              />
              <p>
                회원이 로그인해 있어도 <code>naru.query()</code>로 부르면
                방문자로 부릅니다. 회원으로 부르려면 <code>member</code>의
                메서드를 쓰세요.
              </p>
              <h3 className="font-bold">ctx</h3>
              <Table
                head={["", "뜻"]}
                rows={[
                  [
                    <code key="c">member · owner · visitor</code>,
                    "누가 불렀는지 (위 표)",
                  ],
                  [
                    <code key="c">now</code>,
                    "호출 시각(밀리초). 한 호출 안에서 바뀌지 않습니다.",
                  ],
                  [
                    <code key="c">sql</code>,
                    "사이트 테이블에 SQL 한 문장을 실행합니다.",
                  ],
                  [
                    <code key="c">fail(코드, 메시지, 세부)</code>,
                    "요청을 거절하고 쓴 것을 되돌립니다.",
                  ],
                  [
                    <code key="c">rolesOf(회원ID 목록)</code>,
                    "회원들의 역할 (한 번에 100명까지)",
                  ],
                  [
                    <code key="c">passwords.verify(비밀번호, 해시, 키)</code>,
                    "손님 비밀번호 확인",
                  ],
                  [
                    <code key="c">passwords.hash(비밀번호)</code>,
                    "손님 비밀번호의 해시 (뮤테이션만)",
                  ],
                  [
                    <code key="c">setRoles(회원ID, 역할)</code>,
                    "회원의 역할을 바꿉니다 (뮤테이션만)",
                  ],
                ]}
              />
              <p>
                <code>ctx</code>의 메서드는 Promise를 돌려주므로{" "}
                <code>await</code>하세요. <code>await</code>하지 않은 호출이
                있으면 호출 전체가 실패하고 되돌려집니다. 인자 없이 부르면
                인자는 <code>undefined</code>라서{" "}
                <code>{"{ board } = {}"}</code>
                같은 기본값이 그대로 쓰입니다.
              </p>
              <h3 className="font-bold">ctx.sql</h3>
              <p>
                <code>{"ctx.sql`SELECT … WHERE id = ${id}`"}</code>처럼 태그로
                쓰면 <code>{"${…}"}</code> 안의 값은 모두 매개변수로 묶이므로,
                방문자가 보낸 값을 그대로 넣어도 SQL이 바뀌지 않습니다. 쿼리
                빌더가 만든 문장은 <code>ctx.sql(문장, 값 목록)</code>으로
                넘깁니다. 결과는 <code>{"{ rows, changes }"}</code>입니다.
              </p>
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  한 번에 한 문장, <code>SELECT</code>·<code>INSERT</code>·
                  <code>UPDATE</code>·<code>DELETE</code>(와 <code>WITH</code>·
                  <code>RETURNING</code>)를 씁니다. 쿼리에서는{" "}
                  <code>SELECT</code>만 됩니다. 테이블을 만들고 바꾸는 일은
                  마이그레이션에서 합니다.
                </li>
                <li>
                  묶는 값은 문자열, 숫자, 불리언(1·0으로),{" "}
                  <code>Uint8Array</code>
                  (BLOB으로), null이며 100개까지입니다. BLOB 열은{" "}
                  <code>Uint8Array</code>로 돌아옵니다. 한 문장은 1,000행·1
                  MiB까지 돌려주니 <code>LIMIT</code>를 붙이세요.
                </li>
                <li>
                  나루의 테이블, PRAGMA, 트리거, 트랜잭션, 재귀 쿼리는
                  거절됩니다.
                </li>
                <li>
                  한 문장은 테이블 하나를 한 번 훑는 데까지 할 수 있습니다. 다른
                  테이블을 줄마다 훑는 조인이나 하위 쿼리는 실행 전에 거절되니,
                  조인하는 열에 색인을 만들고 같은 값으로 조인하세요. 한 호출은
                  모두 합쳐 500,000행까지 읽습니다.
                </li>
                <li>
                  <code>UNIQUE</code> 열에 이미 있는 값을 쓰면{" "}
                  <code>CONFLICT</code>로 실패하고{" "}
                  <code>error.details.unique</code>에 그 열 이름이 담깁니다.
                  닉네임 중복 같은 것을 이렇게 알 수 있습니다. 그 밖의 SQL
                  실수는 SQLite의 설명과 함께 <code>INVALID_REQUEST</code>로
                  실패합니다.
                </li>
              </ul>
              <h3 className="font-bold">손님 글과 비밀번호</h3>
              <p>
                그누보드의 손님 글처럼, 방문자가 비밀번호를 걸어 글을 쓰고
                나중에 같은 비밀번호로 고치거나 지우게 하려면 뮤테이션에서{" "}
                <code>ctx.passwords.hash()</code>로 만든 해시를 테이블에
                저장하고, <code>ctx.passwords.verify()</code>로 확인합니다.
                비밀번호 자체는 어디에도 남지 않습니다.
              </p>
              <Code language="sql">{`-- _naru/migrations/0002_guestbook.sql
CREATE TABLE guestbook (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  password TEXT NOT NULL -- 해시만 저장됩니다
);`}</Code>
              <Code>{`// _naru/mutations/guestbook.js
export async function write(ctx, { name, text, password }) {
  const hash = await ctx.passwords.hash(password);
  const { rows } = await ctx.sql\`
    INSERT INTO guestbook (name, text, password)
    VALUES (\${name}, \${text}, \${hash}) RETURNING id\`;
  return rows[0].id;
}

export async function edit(ctx, { id, text, password }) {
  const [entry] = (await ctx.sql\`SELECT password FROM guestbook WHERE id = \${id}\`).rows;
  if (!entry || !(await ctx.passwords.verify(password, entry.password, \`guestbook:\${id}\`)))
    ctx.fail("ACCESS_DENIED", "비밀번호가 맞지 않습니다.");
  await ctx.sql\`UPDATE guestbook SET text = \${text} WHERE id = \${id}\`;
}

// _naru/queries/guestbook.js: password 열은 돌려주지 않습니다.
export async function list(ctx) {
  return (await ctx.sql\`SELECT id, name, text FROM guestbook ORDER BY id DESC LIMIT 50\`).rows;
}

// 페이지에서, 로그인 없이
await naru.mutate("guestbook:write", { name: "손님", text: "안녕하세요", password });`}</Code>
              <p>
                <code>verify</code>의 세 번째 인자는 무엇을 여는 비밀번호인지를
                나타내는 키입니다(<code>guestbook:42</code>처럼). 한 키에 틀린
                비밀번호는 누가 시도하든 한 시간에 열 번까지이고, 그 뒤에는 맞는
                비밀번호도 <code>RATE_LIMITED</code>로 실패하니, 짧은 비밀번호도
                하나씩 맞혀 볼 수 없습니다. 한 번 부를 때 비밀번호 해시와 확인은
                합쳐서 세 번까지입니다.
              </p>
              <h3 className="font-bold">공통 코드와 타입</h3>
              <p>
                공통 코드는 <code>_naru/modules/</code>에 두고 상대 경로로
                import하거나 다시 내보낼 수 있습니다. 경로에 <code>.js</code>를
                포함하세요. 번들 생성은 필요하지 않습니다. 패키지 이름과 URL,
                동적 import, 최상위 await는 지원하지 않습니다. 공통 모듈은
                페이지에서 직접 부를 수 없습니다.
              </p>
              <Code>{`// _naru/modules/text.js
export const clean = (value, max) => String(value ?? "").trim().slice(0, max);

// _naru/mutations/comments.js
import { clean } from "../modules/text.js";
export async function add(ctx, { post, text }) {
  if (!ctx.member) ctx.fail("AUTH_REQUIRED", "회원만 댓글을 쓸 수 있습니다.");
  await ctx.sql\`INSERT INTO comments (post, author, text, created_at)
    VALUES (\${post}, \${ctx.member.id}, \${clean(text, 1000)}, \${ctx.now})\`;
}`}</Code>
              <p>
                파일을 저장하거나 사이트를 설치하면 나루가 <code>_naru/</code>의
                코드와 마이그레이션으로 릴리스를 만들고 적용합니다. import가
                잘못되거나 마이그레이션이 실패하면 이전 릴리스가 계속
                실행됩니다. 파일을 하나씩 올릴 때는 공통 모듈과 마이그레이션부터
                올리세요. 한 호출은 같은 릴리스의 파일만 씁니다.
              </p>
              <p>
                <code>ctx</code>의 타입은{" "}
                <a href="https://sdk.naru.pub/sdk/1.1.0/functions.d.ts">functions.d.ts</a>에 모두
                적혀 있습니다. 내려받아 <code>_naru/types/</code>에 두고
                JSDoc으로 쓰면 편집기가 <code>ctx</code>를 알아봅니다. 로컬 개발
                서버 naru-dev로 사이트를 돌리면 마이그레이션이 만든 테이블마다
                행의 타입을 <code>_naru/types/database.d.ts</code>에 써 줍니다.
              </p>
              <Code>{`// _naru/queries/board.js
/** @type {import("../types/functions").Query<{ board: string }>} */
export const latest = async (ctx, { board }) =>
  (await ctx.sql\`SELECT id, title FROM posts WHERE board = \${board} LIMIT 20\`).rows;`}</Code>
              <p>
                사이트 코드에서는 네트워크와 타이머를 쓸 수 없습니다.{" "}
                <code>URL</code>과 <code>Math.random()</code>은 쓸 수 있습니다.
                사이트 코드 파일은 사이트의 다른 파일처럼 누구나 볼 수 있으니
                비밀값을 넣지 마세요.
              </p>
            </Section>

            <Section id="live" title="10 · 실시간 쿼리">
              <p>
                5초마다 다시 읽는 대신 <code>subscribe()</code>로 쿼리를
                들으세요. 나루가 쿼리를 바로 한 번 돌려 답을 주고, 그 뒤에
                뮤테이션이 쿼리가 읽은 테이블을 바꿔 답이 달라질 때마다 새 답을
                보냅니다. 방문자는 <code>naru.subscribe()</code>, 회원은{" "}
                <code>member.subscribe()</code>로 듣고, 쿼리는{" "}
                <code>query()</code>로 부를 때와 같은 사람으로 돕니다.
              </p>
              <Code>{`const live = naru.subscribe(
  "board:recent",
  {},
  (posts) => render(posts),
  { onError: (error) => (status.textContent = error.message) },
);

// 더 듣지 않을 때
live.close();`}</Code>
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  같은 페이지의 실시간 쿼리는 연결 하나를 나눠 쓰며, 연결 하나에
                  20개까지 들을 수 있습니다. 마지막 쿼리를 닫으면 연결도
                  닫힙니다.
                </li>
                <li>
                  연결이 끊기면 스스로 다시 이어지고, 이어지면 모든 쿼리를 다시
                  물어 놓친 답을 받습니다. 회원의 승인이 취소되거나 차단되면
                  연결이 닫힙니다.
                </li>
                <li>
                  처음 한 번은 쿼리 호출로 세고, 쓰기 뒤에 다시 도는 것은 세지
                  않습니다. 답이 그대로이면 아무것도 보내지 않습니다.
                </li>
                <li>
                  사이트 테이블의 변경만 다시 돌게 합니다. 컬렉션은 실시간으로
                  들을 수 없습니다. 새 릴리스가 적용되면 모든 실시간 쿼리가 다시
                  돕니다.
                </li>
                <li>
                  지금 실패하거나, 나중에 다시 돌다 실패한 것은{" "}
                  <code>onError</code>로 갑니다.
                </li>
              </ul>
            </Section>

            <Section id="routes" title="11 · 라우트">
              <p>
                대부분의 페이지는 정적 HTML과 스크립트로 충분합니다. 다만 글
                하나하나의 주소를 링크로 공유할 때 미리보기에 글 제목이 나오게
                하거나, 검색 엔진과 RSS 리더에 내용을 보여 주려면 서버가
                페이지를 그려야 합니다. 그럴 때 <code>_naru/routes/</code>에
                파일을 두면, 그 주소의 요청에 나루가 파일의 기본 내보내기를 돌려
                답합니다.
              </p>
              <Table
                head={["파일", "답하는 주소"]}
                rows={[
                  [
                    <code key="f">routes/index.js</code>,
                    <code key="p">/</code>,
                  ],
                  [
                    <code key="f">routes/about.js</code>,
                    <code key="p">/about</code>,
                  ],
                  [
                    <code key="f">routes/posts/index.js</code>,
                    <code key="p">/posts, /posts/</code>,
                  ],
                  [
                    <code key="f">routes/posts/_id.js</code>,
                    <>
                      <code>/posts/42</code> (<code>params.id</code>는{" "}
                      <code>&quot;42&quot;</code>)
                    </>,
                  ],
                  [
                    <code key="f">routes/feed.xml.js</code>,
                    <code key="p">/feed.xml</code>,
                  ],
                ]}
              />
              <p>
                <code>_</code>로 시작하는 이름은 경로 한 칸의 무엇이든 받으며,
                같은 주소에 맞는 파일이 둘이면 이름이 정해진 쪽이 먼저입니다.
                라우트와 맞는 주소는 같은 이름의 사이트 파일보다 라우트가
                답하고, 어떤 라우트와도 맞지 않는 주소는 전처럼 사이트 파일이
                답합니다.
              </p>
              <Code>{`// _naru/modules/html.js
export const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => \`&#\${c.charCodeAt(0)};\`);

// _naru/routes/posts/_id.js
import { escape } from "../../modules/html.js";

export default async function (ctx, { path, params, query }) {
  const id = Number(params.id) || 0;
  const [post] = (await ctx.sql\`SELECT title, body FROM posts WHERE id = \${id}\`).rows;
  if (!post) ctx.fail("NOT_FOUND", "글이 없거나 지워졌습니다.");
  return {
    html: \`<!doctype html>
<meta charset="utf-8">
<title>\${escape(post.title)}</title>
<h1>\${escape(post.title)}</h1>
<p>\${escape(post.body)}</p>\`,
    cache: 30,
  };
}`}</Code>
              <p>
                함수는 <code>{"{ path, origin, params, query }"}</code>를
                받습니다. <code>origin</code>은 방문자가 연 주소의 앞부분(
                <code>https://alice.naru.pub</code>이나 연결한 도메인)이라
                <code>og:url</code> 같은 절대 주소를 만들 때 씁니다.{" "}
                <code>query</code>는 주소의 <code>?</code> 뒤 값입니다. 라우트는
                로그인과 상관없이 방문자의 쿼리로 돌아, <code>ctx.visitor</code>
                가 true이고 테이블을 읽기만 합니다. 회원에게만 보일 내용은
                페이지의 스크립트에서 <code>member.query()</code>로 읽으세요.
                HTML에 넣는 값은 위의 <code>escape</code>처럼 직접
                이스케이프해야 합니다.
              </p>
              <Table
                head={["돌려주는 값", "응답"]}
                rows={[
                  [
                    <code key="c">&quot;&lt;h1&gt;…&quot;</code>,
                    "문자열은 HTML 페이지입니다.",
                  ],
                  [<code key="c">{"{ html }"}</code>, "HTML 페이지"],
                  [
                    <code key="c">{"{ body, type }"}</code>,
                    <>
                      RSS·JSON 같은 글. <code>type</code>은{" "}
                      <code>application/rss+xml</code>·
                      <code>application/atom+xml</code>·
                      <code>application/json</code>·<code>application/xml</code>
                      ·<code>text/xml</code>·<code>text/plain</code>·
                      <code>text/css</code>·<code>text/calendar</code> 중
                      하나입니다.
                    </>,
                  ],
                  [
                    <code key="c">{"{ file, head }"}</code>,
                    <>
                      사이트 파일(예: <code>post.html</code>)을 그대로 보내되{" "}
                      <code>head</code>를 그 파일의 <code>&lt;head&gt;</code>에
                      넣습니다. 페이지는 스크립트가 그리고, 링크 미리보기용{" "}
                      <code>og:title</code> 같은 태그만 서버에서 넣을 때 씁니다.
                    </>,
                  ],
                  [
                    <code key="c">{"{ redirect }"}</code>,
                    <>
                      그 주소로 보냅니다. <code>/</code>로 시작하는 경로나{" "}
                      <code>https://</code> 주소이고, 기본 상태는 302입니다.
                    </>,
                  ],
                ]}
              />
              <p>
                객체에는 <code>status</code>(200~599)와 <code>cache</code>
                (0~300초)를 함께 넣을 수 있습니다. <code>cache</code>를 주면
                나루가 그 시간 동안 같은 주소의 페이지를 다시 그리지 않고
                보내므로, 그동안은 글이 바뀌어도 이전 페이지가 보입니다.{" "}
                <code>ctx.fail</code>을 부르면 그 상태 코드와 메시지로 오류
                페이지를 보냅니다. 라우트는 <code>GET</code> 요청에만 답하니,
                글쓰기는 페이지의 스크립트에서 뮤테이션으로 하세요.
              </p>
              <Code>{`// 글은 post.html의 스크립트가 그리고, 미리보기 태그만 넣습니다.
return {
  file: "post.html",
  head: \`<meta property="og:title" content="\${escape(post.title)}">\`,
  cache: 60,
};`}</Code>
            </Section>

            <Section id="recipes" title="12 · 사용 예">
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
                    title: "특정 글의 댓글",
                    setup: "comments · 읽기 누구나 / 쓰기 누구나 생성만",
                    code: `naru
  .collection("comments")
  .list({
    filter: { postId: "hello" },
  });`,
                  },
                  {
                    title: "회원 게시판",
                    setup: (
                      <>
                        posts 테이블 · <a href="#code">쿼리와 뮤테이션</a>
                      </>
                    ),
                    code: `await member.mutate("board:write",
  { title, body });
naru.subscribe("board:recent", {},
  (posts) => render(posts));`,
                  },
                  {
                    title: "게시판 검색",
                    setup: "posts 테이블 · _naru/queries/board.js",
                    code: `export async function search(ctx, { word }) {
  return (await ctx.sql\`
    SELECT id, title FROM posts
    WHERE title LIKE '%' || \${word} || '%'
    ORDER BY id DESC LIMIT 20\`).rows;
}`,
                  },
                  {
                    title: "회원 사진 올리기",
                    setup: (
                      <>
                        <a href="/docs/1.1.0/media">미디어</a> · 회원 업로드
                      </>
                    ),
                    code: `const image =
  await member.media.upload(file);
await member.mutate("board:write",
  { title, body, image: image.url });`,
                  },
                  {
                    title: "손님 비밀글",
                    setup: (
                      <>
                        guestbook 테이블 · <a href="#code">ctx.passwords</a>
                      </>
                    ),
                    code: `await naru.mutate("guestbook:edit",
  { id, text, password });`,
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

            <Section id="errors" title="13 · 한도와 오류">
              <ul className="list-disc space-y-3 pl-6">
                <li>
                  사이트당 컬렉션 100개, 문서 100,000개, 데이터는 컬렉션과
                  사이트 테이블을 합쳐 100 MiB. 컬렉션 요청 하나는 64
                  KiB까지입니다.
                </li>
                <li>
                  방문자의 컬렉션 <code>add</code>는 분당 횟수가 제한됩니다.
                </li>
                <li>
                  쿼리와 라우트는 읽기로 세어, 컬렉션 읽기와 합쳐 회원이나
                  주소마다 분당 600번까지입니다.
                </li>
                <li>
                  뮤테이션은 회원마다 분당 30번, 방문자는 주소마다 분당 20번,
                  사이트 전체에서 분당 300번까지입니다. 소유자의 호출은 세지
                  않습니다.
                </li>
                <li>
                  사이트 코드 한 번은 데이터베이스 작업(<code>ctx.sql</code> 한
                  문장, <code>rolesOf</code>, <code>setRoles</code>,{" "}
                  <code>Math.random()</code> 한 번씩) 100번, 비밀번호 해시와
                  확인 3번, 수십 밀리초, 메모리 32 MiB까지 쓰고, 돌려주는 값은
                  JSON으로 1 MiB까지입니다.
                </li>
                <li>
                  사이트 코드 파일은 하나에 256 KiB, 모두 256개까지입니다.
                </li>
                <li>관리자 로그인 페이지는 사이트당 20개까지 등록합니다.</li>
              </ul>
              <p>
                실패하면 <code>NaruError</code>를 던집니다. 방문자에게는{" "}
                <code>error.message</code>를 보여 주세요. 나루의 오류는 한국어로
                적혀 있고, 사이트 코드의 <code>ctx.fail</code>은 그 메시지
                그대로입니다. 무엇이 왜 실패했는지 개발자를 위한 자세한 설명은{" "}
                <code>error.cause.message</code>에 영어로 있으니, 막히면
                콘솔에서 확인하세요. 처리를 나눌 때는 <code>code</code>를
                쓰세요.
              </p>
              <Table
                head={["code", "뜻"]}
                rows={[
                  [
                    "NOT_FOUND",
                    "문서, 컬렉션, 쿼리·뮤테이션 또는 사이트가 없습니다.",
                  ],
                  [
                    "ACCESS_DENIED",
                    "공개 범위나 등록된 컬렉션이 허용하지 않거나, 회원이 승인 대기·차단 상태입니다(error.details.membership).",
                  ],
                  [
                    "AUTH_REQUIRED",
                    "관리자나 회원의 로그인이 만료되었습니다. 다시 로그인하세요.",
                  ],
                  [
                    "CONFLICT",
                    "condition이 맞지 않거나, unique 필드나 UNIQUE 열의 값이 이미 쓰이고 있습니다(error.details.unique).",
                  ],
                  [
                    "QUOTA_EXCEEDED",
                    "데이터나 미디어 저장 공간이 가득 찼습니다.",
                  ],
                  [
                    "RATE_LIMITED",
                    "요청이 너무 많거나, 틀린 비밀번호가 너무 많습니다. 잠시 후 다시 시도하세요.",
                  ],
                  [
                    "INVALID_REQUEST",
                    "이름, 필터, 크기, SQL 등 요청 형식이 잘못되었거나 사이트 코드가 한도를 넘었습니다.",
                  ],
                  [
                    "UNAVAILABLE",
                    "일시적인 오류입니다. 나루 서버가 잠시 대기 서버로 넘어가 있는 동안에는 읽기만 되고 쓰기는 이 오류로 실패합니다.",
                  ],
                ].map(([code, meaning]) => [
                  <code key="c">{code}</code>,
                  meaning,
                ])}
              />
              <p>
                사이트 코드의 <code>ctx.fail</code>은 위의 코드 중 하나를 골라
                씁니다. 같은 코드라도 메시지와 세부는 사이트가 정합니다.
              </p>
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
