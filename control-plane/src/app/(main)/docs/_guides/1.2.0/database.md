---
title: 정적 웹사이트에 데이터를 더하세요.
pageTitle: 데이터베이스 사용 안내 | 나루
description: 나루 제어판과 웹 SDK로 블로그, 방명록, 회원 게시판과 관리자 글쓰기를 만드는 방법
path: DATABASE / SDK 1.2.0
links: [데이터베이스 제어판 열기 →](/database) [데이터베이스 템플릿 둘러보기 →](/board?kind=template&database=1) [SDK 레퍼런스 →](/docs/sdk/1.2.0)
---

별도 서버 없이 글을 공개하고, 방문자의 인사를 받고, 내 웹사이트에서 글을
작성하세요.

## 01 · 빠른 시작 {#start}

[제어판](/database)에서 `posts` 컬렉션을 만들고 읽기를 공개로 바꾸세요. 제목이
있는 문서를 하나 저장한 뒤 페이지에 아래 코드를 넣으세요.

```json
{
  "title": "첫 번째 글"
}
```

```html
<ul id="posts"></ul>
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1.2.0/naru.js";

  const naru = createNaru({ site: "{{site}}" });
  const { documents } = await naru.collection("posts").list();
  for (const post of documents) {
    const item = document.createElement("li");
    item.textContent = post.data.title;
    document.querySelector("#posts").append(item);
  }
</script>
```

`createNaru()`에는 늘 `site`로 나루 아이디를 넘기세요(이 예제에서는 `{{site}}`).
`아이디.naru.pub`에서는 없어도 되지만, 없으면 커스텀 도메인이나 내 컴퓨터에서 연
페이지에서는 어느 사이트인지 몰라 오류가 납니다.

### 방명록에 인사 남기기

제어판에서 `guestbook` 컬렉션을 만들고 읽기는 ‘누구나’, 쓰기는 ‘누구나
생성만’으로 설정하세요.

```html
<button id="hello">인사 남기기</button>
<p id="result"></p>
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1.2.0/naru.js";
  const naru = createNaru({ site: "{{site}}" });
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
</script>
```

방문자가 쓴 글을 화면에 보여 줄 때는 이 예제처럼 `textContent`를 쓰세요.
`innerHTML`에 넣으면 글 속에 숨긴 스크립트가 실행될 수 있습니다.

## 02 · 나루가 일하는 방식 {#ideas}

나루의 데이터베이스는 서버 없이 정적 웹사이트에 데이터를 더합니다. 그 대신
지켜야 할 생각이 몇 가지 있고, SDK의 모양은 모두 여기서 나왔습니다.

### 페이지는 방문자의 것입니다

페이지의 스크립트는 방문자의 브라우저에서 돌고, 방문자는 그 코드를 마음대로 고칠
수 있습니다. 그래서 페이지가 정한 것은 믿을 수 없습니다. 페이지는 보여 주고
요청할 뿐이고, 누가 무엇을 할 수 있는지는 나루와 나루에서 도는 사이트 코드가
정합니다. 가격, 잔액, 권한, 주사위처럼 속이면 안 되는 것은 모두 그곳에서
정하세요.

### 데이터를 두는 곳은 두 가지입니다

|              | 컬렉션                                     | 사이트 테이블                                          |
| ------------ | ------------------------------------------ | ------------------------------------------------------ |
| 모양         | 문서마다 JSON 하나                         | `_naru/migrations/`의 SQL로 만든 SQLite 테이블         |
| 읽고 쓰는 길 | 페이지가 SDK의 `collection(이름)`으로 바로 | 사이트의 [쿼리와 뮤테이션](#code)을 거쳐서만           |
| 누가 정하나  | 컬렉션마다 하나의 공개 범위                | 사이트 코드가 부른 사람을 보고 정합니다                |
| 알맞은 곳    | 블로그 글, 방명록, 문의함, 익명 댓글, 설정 | 회원 글과 댓글, 포인트, 상점처럼 규칙이 있는 데이터    |

둘은 서로 섞이지 않습니다. 사이트 코드의 SQL은 컬렉션을 읽을 수 없고, 컬렉션의
SDK는 테이블을 읽을 수 없습니다. 한 사이트에서 둘을 함께 써도 됩니다.

### 세 사람

요청하는 사람은 셋입니다. 로그인하지 않은 **방문자**, 자기 나루 계정으로 이
사이트에 로그인한 **회원**, 사이트의 **소유자**입니다. 방문자와 소유자는
컬렉션을 공개 범위에 따라 읽고 씁니다. 회원은 컬렉션에 따로 권한이 없고, 사이트
코드를 부릅니다. 셋 모두 같은 `query(이름, 인자)`와 `mutate(이름, 인자)`를
부르고, 사이트 코드는 `ctx.member`와`ctx.owner`로 누가 불렀는지 압니다. 둘 다
없으면 방문자입니다.

### 지키는 곳

필요한 만큼만 쓰세요. 위에서부터 가장 단순합니다.

| 필요한 것                  | 쓸 것                     | 예                                                   |
| -------------------------- | ------------------------- | ---------------------------------------------------- |
| 컬렉션 전체에 하나의 규칙  | [공개 범위](#collections) | 공지는 누구나 읽고 관리자만 쓴다                     |
| 사람마다, 글마다 다른 권한 | [쿼리와 뮤테이션](#code)  | 회원은 자기 글만 고치고, 운영진은 모든 글을 지운다   |
| 여러 행을 함께 바꾸는 일   | [뮤테이션](#code)         | 물건을 사면 잔액과 재고와 인벤토리가 한꺼번에 바뀐다 |

뮤테이션 한 번은 트랜잭션 하나라서, 다 되거나 아무것도 바뀌지 않습니다. 중간에
멈춘 구매처럼 반쯤 된 상태는 생기지 않습니다.

### 사이트 파일이 곧 설정입니다

컬렉션, 테이블, 쿼리, 뮤테이션, 라우트는 사이트의 `_naru/` 폴더에 둡니다.
사이트와 함께 GitHub에 올라가고, 템플릿을 설치하면 함께 복사되며, 파일을 올리면
바로 적용됩니다. 제어판에서 하나씩 누르지 않아도 사이트가 스스로 필요한 것을
갖춥니다. 다만 이미 있는 컬렉션의 공개 범위를 바꾸는 내용은 소유자가 제어판에서
확인한 뒤에 적용됩니다. 이 파일들은 방문자에게 공개되지 않지만, GitHub에 올리거나
템플릿으로 나누면 함께 나가니 비밀값을 넣지 마세요.

### 작고 빠르게, 정해진 한도 안에서

모든 사이트가 서버를 나눠 쓰므로 사이트 코드에는 한도가 있습니다. 한 번에
데이터베이스 작업 100번, 수십 밀리초입니다. 한도는 실수를 일찍 드러냅니다.
끝없는 반복이나 한 번에 모든 글을 읽는 코드는 실패하고, 바꾼 것은 되돌려집니다.
많은 글을 다룰 때는 색인을 만들고 `LIMIT`로 필요한 만큼만 읽으세요.

### 오류는 방문자에게 보여 줄 수 있게

실패하면 `error.message`를 그대로 화면에 띄워도 되도록, 나루의 오류는 한국어로,
사이트 코드의 `ctx.fail`은 사이트가 쓴 말 그대로 옵니다. 처리를 나눌 값은
`error.code`와 `error.details`에 있습니다.

## 03 · PHP와 견주어 보기 {#php}

그누보드나 PHP로 게시판을 만들어 봤다면, 나루에서도 하는 일은 같습니다. PHP
파일이 하던 일은 사이트 코드가 맡고, 페이지의 스크립트가 그것을 이름으로
부릅니다. SQL도 그대로 씁니다.

| PHP에서                         | 나루에서                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `CREATE TABLE`                  | [`_naru/migrations/0001_posts.sql`](#code)에 같은 SQL을 적습니다.            |
| `SELECT … WHERE board = 'free'` | 쿼리 안에서 `` ctx.sql`SELECT … WHERE board = ${board}` ``                   |
| `WHERE title LIKE '%봄%'`       | 쿼리 안에서 같은 LIKE를 씁니다.                                              |
| `LIMIT 20 OFFSET 40`            | 쿼리 안의 `LIMIT`. 컬렉션은 `size`와 `nextCursor`로 다음 쪽을 읽습니다.      |
| `INSERT`                        | 뮤테이션 안의 `` ctx.sql`INSERT …` ``. 컬렉션은 `add(data)`                  |
| `$_SESSION['mb_id']`            | [회원 로그인](#members) 뒤 사이트 코드의 `ctx.member.id`                     |
| `$member['mb_level']`           | 사이트 테이블의 회원 역할 ([역할](#members))                                 |
| `alert('권한이 없습니다.')`     | 사이트 코드의 `ctx.fail(코드, 메시지)`. 메시지가 그대로 방문자에게 보입니다. |

`_naru/`의 폴더도 PHP 사이트에 익숙한 자리가 있습니다.

| 나루                           | PHP 사이트에서                                    | 다른 점                                                                                         |
| ------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `_naru/migrations/`            | `install.sql`과 업데이트마다 돌리던 SQL           | 파일을 올리면 나루가 차례대로 한 번씩 적용합니다. 적용된 파일은 고치지 않고 새 파일을 더합니다. |
| `_naru/queries/`               | `list.php`·`view.php`처럼 읽는 파일               | 주소 대신 이름으로 부릅니다: `naru.query("board:recent")`                                       |
| `_naru/mutations/`             | 폼이 보내는 `write_update.php` 같은 파일          | `member.mutate("board:write", 인자)`. 한 번이 트랜잭션 하나입니다.                              |
| `_naru/routes.json, routes.js` | `board.php?id=3`처럼 서버가 그리는 페이지         | 필요할 때만 씁니다. 대부분의 페이지는 정적 HTML과 스크립트로 충분합니다.                        |
| `_naru/modules/`               | `include 'lib/common.lib.php'`로 불러 쓰던 `lib/` | 사이트 코드가 import합니다. 페이지에서 직접 부를 수는 없습니다.                                 |
| `_naru/collections.json`       | —                                                 | SQL 없이 JSON 문서를 모으는 컬렉션을 정합니다.                                                  |

실제 커뮤니티 하나를 통째로 옮긴 예는
[네오 아보카도](https://github.com/naru-pub/neo-avocado)입니다. 아보카도
에디션(그누보드 기반)을 나루로 옮긴 것이라, PHP 파일과 나루 파일을 나란히 견주어
볼 수 있습니다.

## 04 · 컬렉션과 공개 범위 {#collections}

**컬렉션**은 문서를 모으는 곳이고, **문서**는 ID 하나와 JSON 데이터 하나입니다.
이름과 문서 ID는 영문·숫자·`_`·`-` 1~64자입니다.

|      | 설정                      | 방문자가 할 수 있는 일                                              |
| ---- | ------------------------- | ------------------------------------------------------------------- |
| 읽기 | 관리자만                  | 방문자는 읽을 수 없습니다.                                          |
| 읽기 | 누구나                    | `get`·`list`·`count`·`pages`로 누구나 읽습니다.                     |
| 쓰기 | 관리자만                  | 방문자는 쓸 수 없습니다.                                            |
| 쓰기 | 누구나 생성만             | `add`로 새 문서만 만듭니다. 방명록에 알맞습니다.                    |
| 쓰기 | 누구나 생성·덮어쓰기·삭제 | 누구나 모든 문서를 바꾸고 지울 수 있습니다. 대부분은 필요 없습니다. |

관리자는 [로그인](#admin)하면 등록한 컬렉션을 공개 범위와 상관없이 읽고 쓸 수
있습니다. 공개 읽기 컬렉션의 문서는 누구나 읽을 수 있으니, 비공개로 둘 데이터는
‘관리자만’ 읽는 컬렉션에 따로 저장하세요. 회원만 읽거나 글쓴이만 고치는 데이터는
컬렉션 대신 [사이트 테이블](#code)에 두세요.

### 파일로 컬렉션 정하기

사이트 파일에 `_naru/collections.json`을 두면, 파일을 올릴 때 나루가 없는
컬렉션을 만듭니다. 템플릿을 설치한 사람도 제어판에서 하나씩 만들 필요가
없습니다. 이미 있는 컬렉션의 공개 범위나 unique 필드를 바꾸는 내용은 소유자가
[제어판](/database)에서 확인한 뒤에 적용됩니다.

```json
{
  "collections": {
    "posts": { "read": "world", "write": "admin", "indexes": ["category"] },
    "guestbook": { "read": "world", "write": "create" },
    "subscribers": { "read": "admin", "write": "create", "unique": ["email"] }
  }
}
```

`read`는 `admin`·`world`(누구나), `write`는 여기에 `create`(누구나 생성만)를
더한 셋 중 하나이며 둘 다 꼭 적어야 합니다. `unique`는 겹치면 안 되는
필드입니다. 다른 문서가 이미 가진 값을 쓰면 `CONFLICT`로 실패하고,
`error.details.unique`에 그 필드 이름이 담깁니다.

`indexes`에는 자주 거르는 필드를 5개까지 적습니다. 분류별 목록(`category`)처럼
그 필드로 거른 목록을 최신순·오래된순으로 읽을 때, 문서가 많아도 모든 문서를
살피지 않고 필요한 쪽만 읽습니다. 10만 개 중 스무 개를 찾는 데 수십 밀리초
걸리던 것이 0.1밀리초 안쪽이 됩니다. 대신 그 컬렉션의 쓰기가 조금 느려지고, 다른
필드로 정렬하는 데는 쓰이지 않습니다. 색인만 바꾸는 내용은 누구에게도 무엇을
열지 않으므로 파일을 올리면 바로 적용됩니다.

## 05 · 관리자 로그인 {#admin}

나루 홈페이지의 소유자가 로그인하면 홈페이지에 로그인할 수 있습니다.

1. 제어판의 ‘웹사이트 관리자 로그인’에 관리자 페이지 주소(예:
   `https://example.naru.pub/`)와 쓸 컬렉션을 등록합니다.
2. `naru.auth.signIn()`으로 로그인하고 `naru.auth.session()`으로 관리자
   클라이언트를 받습니다.

```html
<button id="login">관리자 로그인</button>
<p id="auth-status"></p>
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1.2.0/naru.js";
  const naru = createNaru({ site: "{{site}}" });
  const admin = await naru.auth.session();
  const login = document.querySelector("#login");
  login.hidden = !!admin;
  document.querySelector("#auth-status").textContent =
    admin ? "로그인되었습니다." : "글을 고치려면 로그인하세요.";
  login.onclick = () => naru.auth.signIn({ collections: ["posts", "drafts"] });
  // 다음 예제의 owner는 이 스크립트 안에서 사용하세요.
</script>
```

`session()`은 이 페이지에서 로그인한 적이 있으면 관리자 클라이언트를, 아니면
null을 돌려줍니다. 로그인을 끝내려면 `admin.signOut()`을 부르세요. 나루에 남은
이 페이지의 로그인도 함께 끝납니다.

```
await admin.signOut();
location.reload();
```

관리자도 `admin.query()`·`admin.mutate()`로 사이트 코드를 부릅니다. 이때
`ctx.owner`는 true, `ctx.member`는 null이고, 소유자의 호출은 횟수 제한에 세지
않습니다. 컬렉션은 쓰지 않고 사이트 코드로만 관리하는 페이지라면 `collections`
없이 `naru.auth.signIn()`으로 로그인하세요.

## 06 · 글 수정과 충돌 처리 {#write}

| 호출                           | 동작                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `add(data)`                    | 새 ID로 문서를 만듭니다.                                         |
| `set(id, data, { condition })` | 그 ID의 문서를 만들거나 통째로 바꿉니다. 필드를 합치지 않습니다. |
| `delete(id, { condition })`    | 문서를 지웁니다. 없는 문서를 지워도 성공합니다.                  |

`condition`으로 덮어쓰기를 막을 수 있습니다. `{ revision }`은 읽은 뒤 바뀌지
않았을 때만, `{ absent: true }`는 아직 없는 문서일 때만 저장하고, 아니면
`CONFLICT`로 실패합니다.

```
const post = await admin.collection("posts").get("hello");
try {
  await admin.collection("posts").set(
    "hello",
    { ...post.data, title: "새 제목" },
    { condition: { revision: post.revision } },
  );
} catch (error) {
  if (error.code !== "CONFLICT") throw error;
  alert("다른 곳에서 먼저 저장했습니다. 새로고침 후 다시 시도하세요.");
}
```

데이터에는 JSON 값만 넣으세요.

### 여러 변경을 함께 저장하기

`admin.batch()`은 여러 컬렉션의 `set`·`delete`를 최대 100개까지 묶어, 원자적으로
반영합니다. 각 변경의 condition도 함께 검사합니다. 미리 읽은 값이 저절로
보호되는 것은 아니므로 고치는 문서의 revision을 넘기세요. 결과는 쓴 순서대로,
`set`은 `{ id, revision, createdAt, updatedAt }`, `delete`는 `null`입니다.

```
const [saved] = await admin.batch([
  { collection: "posts", set: { id, data: post, condition: { absent: true } } },
  { collection: "drafts", delete: { id, condition: { revision: draft.revision } } },
]);
// saved.revision → 다음 저장의 condition
```

## 07 · 목록과 페이지 나누기 {#read}

```
const posts = naru.collection("posts");

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
}
```

- **filter**: 최상위 필드를 값으로 비교하거나 `{ gt, gte, lt, lte }`로 범위를
  찾습니다. 조건은 모두 만족해야 하며(AND) 최대 5개입니다. 날짜는
  `"2026-09-01"`처럼 자리를 채운 문자열로 저장하면 범위로 찾을 수 있습니다.
- **sort**: `[필드, 방향]`을 한두 개 넘깁니다. 생성·수정 시각은
  `{ metadata: "createdAt" }`처럼 씁니다. 기본은 ID 오름차순입니다. 같은
  날짜에서 최신 글을 먼저
  보려면`[["date", "desc"], [{ metadata: "createdAt" }, "desc"]]`처럼 두 키를
  씁니다. 문자열은 언어별 정렬 없이 유니코드 순서로, 숫자는 크기로 비교합니다.
  오름차순에서 없는 값·null·배열·객체, 문자열, 숫자, 불리언 순입니다.
- **size**: 한 번에 기본 50개, 최대 100개입니다. 다음 페이지는 같은
  filter·sort에 `nextCursor`를 `after`로 넘기고, `nextCursor`가 `null`이면
  끝입니다. `includeTotal: true`면 전체 개수도 받습니다. 개수만 필요하면
  `count()`를, 모든 쪽이 필요하면 `pages()`를 쓰세요. 누구나 쓸 수 있는 컬렉션은
  끝까지 읽지 말고 필요한 만큼만 받으세요.
- **쪽 번호**: 몇 번째부터 건너뛰는 offset은 없습니다. 3쪽을 보이려면 1쪽부터
  `nextCursor`를 따라가고, 받은 커서를 쪽 번호와 함께 저장해 두면 앞뒤로 오갈 때
  다시 읽지 않습니다.

글자가 들어 있는 글을 찾는 검색이나 여러 조건을 또는(OR)으로 묶는 목록은
컬렉션으로 할 수 없습니다. 그런 데이터는 [사이트 테이블](#code)에 두고 쿼리에서
SQL로 찾으세요.

### 요청 취소하기

읽기, 쓰기, 업로드, 쿼리와 뮤테이션은 옵션으로 `signal`을 받습니다. 검색어를
바꿀 때 이전 검색을 멈추는 것처럼, 더 필요 없는 요청은 `AbortController`로
취소하세요. 취소된 요청은 `NaruError`가 아니라 브라우저의 `AbortError`로 끝나며,
나루가 이미 받은 쓰기는 되돌리지 않습니다.

```
let searching;
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
};
```

## 08 · 회원 {#members}

**회원**은 자기 나루 계정으로 이 사이트에 로그인한 방문자입니다. 미리 등록할
것은 없고, 페이지에서 `naru.members.signIn()`을 부르면 나루에서 로그인하고
(계정이 없으면 만들고) 이 페이지로 돌아옵니다. `naru.members.session()`은
로그인한 회원을, 아니면 null을 돌려줍니다. SDK 1.1.0부터 쓸 수 있습니다.

```html
<button id="join">회원 로그인</button>
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1.2.0/naru.js";
  const naru = createNaru({ site: "{{site}}" });
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
</script>
```

`member.id`는 이 사이트에서만 쓰이는 회원 번호이고, 방문할 때마다 같습니다.
회원의 나루 아이디와 이메일은 사이트에 전달되지 않습니다. 회원이 할 수 있는 일은
사이트 코드가 정합니다. 회원은 `member.query()`·`member.mutate()`로
[사이트 코드](#code)를 부르고, `member.subscribe()`로 [실시간 쿼리](#live)를
듣습니다. 그러면 사이트 코드에서 `ctx.member`가 `{ id }`입니다. 회원은 컬렉션에
따로 권한이 없으니, 컬렉션은 방문자로서 `naru.collection()`으로 읽습니다.

회원 로그인은 사이트의 모든 페이지와 탭에서 유지되며, 7일 동안 쓰지 않거나
로그인한 지 30일이 지나면, 또는 나루에서 로그아웃하면 끝납니다. 페이지에서
끝내려면 `member.signOut()`을 부르세요. 회원은 `member.media.upload()`로
사이트의 [미디어](/docs/1.2.0/media)에 파일을 올릴 수 있습니다. 업로드는
회원마다 한 시간에 30개까지이고, 올린 파일은 사이트 소유자가 미디어
라이브러리에서 지웁니다. 소유자가 허용하면 로그인하지 않은 방문자도
`naru.media.upload()`로 올릴 수 있습니다(SDK 1.2.0,
[방문자 업로드](/docs/1.2.0/media#visitors)).

### 가입과 승인

[제어판](/database)의 ‘사이트 회원’에서 신규 가입을 ‘누구나 가입’, ‘운영자 승인
후 이용’, ‘신규 가입 중단’ 중에 고르고, 이메일을 인증한 계정만 받을지 정합니다.
회원 목록에서 회원을 승인하거나 차단할 수 있습니다. 승인을 기다리거나 차단된
회원의 요청은 `ACCESS_DENIED`로 실패하고, `error.details.membership`이
`"pending"` 또는 `"banned"`이니 페이지에서 알맞은 안내를 보여 주세요. 로그인은
남아 있어서, 승인되면 다시 로그인하지 않아도 됩니다.

### 역할

운영진, 회원 레벨, 그룹 같은 **역할**은 나루가 따로 보관하지 않습니다.
마이그레이션으로 역할 테이블을 만들고, `ctx.member.id`를 키로 사이트 코드에서
읽고 쓰세요. 누가 역할을 줄 수 있는지도 사이트 코드가 확인합니다.

```
-- _naru/migrations/0002_roles.sql
CREATE TABLE roles (
  member TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (member, role)
);
```

```
// _naru/mutations/staff.js
export async function promote(ctx, { member }) {
  if (!ctx.owner) {
    const { rows } = await ctx.sql`
      SELECT 1 FROM roles WHERE member = ${ctx.member?.id} AND role = 'staff'`;
    if (!rows.length) ctx.fail("ACCESS_DENIED", "운영진만 할 수 있습니다.");
  }
  await ctx.sql`INSERT OR IGNORE INTO roles VALUES (${member}, 'writer')`;
}
```

## 09 · 사이트 코드: 테이블·쿼리·뮤테이션 {#code}

회원 게시판, 댓글, 포인트처럼 누가 무엇을 할 수 있는지 사이트가 정해야 하는
데이터는 사이트의 SQLite 테이블에 두고, 나루에서 도는 사이트의 코드로 읽고
씁니다. 세 가지 파일을 씁니다.

| 파일                      | 하는 일                                                         | 부르는 법                                |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| `_naru/migrations/*.sql`  | 테이블과 색인을 만들고 바꿉니다.                                | 파일을 올리면 나루가 한 번씩 적용합니다. |
| `_naru/queries/경로.js`   | 테이블을 읽어 돌려줍니다. 쓸 수 없습니다.                       | `naru.query("경로:이름", 인자)`          |
| `_naru/mutations/경로.js` | 검사하고, 쓰고, 결과를 돌려줍니다. 한 번이 트랜잭션 하나입니다. | `member.mutate("경로:이름", 인자)`       |

### 테이블 만들기: 마이그레이션

`_naru/migrations/`에 `.sql` 파일을 둡니다. 나루는 파일을 올릴 때 아직 적용하지
않은 마이그레이션을 이름 순서대로 한 번씩 적용하고, 그 직전의 데이터를 복원
지점으로 남겨 둡니다. 이름 앞에 `0001_`처럼 자리를 채운 번호를 붙이세요.

```sql
-- _naru/migrations/0001_posts.sql
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  author TEXT NOT NULL,       -- 회원 번호 (ctx.member.id)
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL -- ctx.now (밀리초)
);
CREATE INDEX posts_author ON posts (author);
```

- 한 번 적용된 파일은 고치거나 지울 수 없습니다. 열을 더하거나 바꾸려면
  `0002_body_format.sql`처럼 새 파일을 더하세요. 새 파일의 이름은 이미 적용된
  파일보다 뒤에 와야 합니다.
- `CREATE`·`ALTER`·`DROP` (TABLE·INDEX·VIEW)과 데이터를 옮기는
  `INSERT`·`UPDATE`·`DELETE`를 쓸 수 있습니다. 전문 검색 테이블은
  `CREATE VIRTUAL TABLE search USING fts5(title, body, tokenize='trigram')`로
  만들고 `MATCH`나 `LIKE`로 찾습니다. trigram은 한국어도 세 글자 이상이면
  찾습니다. 내용을 직접 갖지 않는 전문 검색 테이블(`content=''`), 다른 가상
  테이블, 트리거, 임시 테이블은 쓸 수 없습니다.
- 마이그레이션 하나라도 실패하면 그 릴리스 전체가 거절되고 아무것도 바뀌지
  않습니다. 이전의 테이블과 코드가 그대로 쓰입니다. 오류를 고친 파일을 다시
  올리세요.
- 적용된 마이그레이션이 데이터를 잘못 바꿨다면 제어판의 데이터베이스 → 복원
  지점에서 그 릴리스 직전으로 복원할 수 있습니다. 컬렉션과 문서, 테이블과 행,
  적용된 마이그레이션 기록, 회원 역할이 그 시점으로 돌아가고 그 뒤의 변경은
  사라집니다. 복원 직전 상태도 복원 지점으로 남으니 되돌릴 수 있습니다. 사이트
  코드는 지금 릴리스 그대로라서, 복원 지점에 없던 마이그레이션은 다음에 `_naru`
  파일을 올릴 때 다시 적용됩니다. 그 전에 그 마이그레이션을 고치거나 지우세요.
  지금 상태를 &lsquo;지금 복원 지점 만들기&rsquo;로 직접 남길 수도 있습니다(한
  시간에 3개까지). 복원 지점은 직접 만든 것도 만든 때부터 7일 동안 보관하고, 그
  뒤에 삭제합니다. 더 오래 두려면 내려받으세요. 내려받은 파일은 gzip으로 압축한
  NDJSON으로, 첫 줄에 테이블 정의, 그 뒤로 한 줄에 한 행씩(사이트 테이블은
  `site:이름`), 마지막 줄에 행 수가 있습니다.
- 첫 공개 전에 마이그레이션을 하나로 합치는 것처럼 이미 적용된 마이그레이션을
  바꿔야 한다면, 데이터베이스 → 복원 지점의 &lsquo;데이터베이스 초기화&rsquo;로
  처음부터 시작할 수 있습니다. 사이트 이름을 입력해 확인하면 지금 상태를 복원
  지점으로 남긴 뒤 컬렉션과 문서, 테이블과 행, 적용된 마이그레이션 기록, 회원
  역할을 모두 지우고, 사이트 코드를 다시 릴리스해 마이그레이션을 빈
  데이터베이스에 적용합니다. 바꾼 마이그레이션을 먼저 올리세요: 그 릴리스는
  거절되지만 파일은 남고, 초기화가 그 파일을 릴리스합니다. 사이트 파일과 미디어,
  사이트 회원 목록은 그대로입니다.
- 테이블의 행은 제어판의 데이터베이스 → 테이블에서 볼 수 있습니다. 테이블마다 한
  번에 100행씩 넣은 순서대로 보이고, 긴 텍스트는 앞부분만, BLOB은 크기만
  보입니다. 읽기만 하며, 행은 사이트의 뮤테이션이나 복원으로 바뀝니다. 그 아래
  SQL 조회에서 SELECT 문 하나를 직접 실행해 처음 1,000행까지 볼 수 있습니다.
  데이터를 바꾸는 문장은 실행하지 않습니다.
- 나루가 쓰는 이름(`collections`, `documents`, `meta`, `usage`, `rate_limits`,
  `media_refs`와 `_naru`·`sqlite_`로 시작하는 이름)은 테이블 이름으로 쓸 수
  없습니다.

### 읽기: 쿼리

`_naru/queries/board.js`에서 내보낸 함수는 `"board:이름"`으로,
`_naru/queries/community/board.js`의 함수는 `"community/board:이름"`으로
부릅니다. 함수는 `ctx`와 페이지가 넘긴 인자를 받고, 돌려준 JSON 값이 페이지에
그대로 갑니다.

```
// _naru/queries/board.js
export async function recent(ctx, { before } = {}) {
  const { rows } = await ctx.sql`
    SELECT id, author, title, created_at FROM posts
    WHERE id < ${before ?? Number.MAX_SAFE_INTEGER}
    ORDER BY id DESC LIMIT 20`;
  return rows;
}

export async function post(ctx, { id }) {
  const [post] = (await ctx.sql`SELECT * FROM posts WHERE id = ${id}`).rows;
  if (!post) ctx.fail("NOT_FOUND", "글이 없거나 지워졌습니다.");
  return post;
}

// 페이지에서
const posts = await naru.query("board:recent");
const more = await naru.query("board:recent", { before: posts.at(-1).id });
```

쿼리는 누구나 부를 수 있습니다. 회원만 읽게 하려면 `ctx.member`를 확인하고,
돌려주면 안 되는 열(비밀번호 해시 같은)은 고르지 마세요. 쿼리는 테이블을 쓸 수
없고, 나루 서버가 잠시 대기 서버로 넘어가 있는 동안에도 답합니다.

### 쓰기: 뮤테이션

```
// _naru/mutations/board.js
export async function write(ctx, { title, body }) {
  if (!ctx.member) ctx.fail("AUTH_REQUIRED", "회원만 글을 쓸 수 있습니다.");
  if (typeof title !== "string" || !title.trim())
    ctx.fail("INVALID_REQUEST", "제목을 입력해 주세요.");
  const { rows } = await ctx.sql`
    INSERT INTO posts (author, title, body, created_at)
    VALUES (${ctx.member.id}, ${title}, ${String(body)}, ${ctx.now})
    RETURNING id`;
  return rows[0].id;
}

export async function remove(ctx, { id }) {
  const [post] = (await ctx.sql`SELECT author FROM posts WHERE id = ${id}`).rows;
  if (!post) return;
  const mine = post.author === ctx.member?.id;
  if (!mine && !ctx.owner)
    ctx.fail("ACCESS_DENIED", "내가 쓴 글만 지울 수 있습니다.");
  await ctx.sql`DELETE FROM posts WHERE id = ${id}`;
}

// 페이지에서
try {
  await member.mutate("board:remove", { id });
} catch (error) {
  status.textContent = error.message; // "내가 쓴 글만 지울 수 있습니다."
}
```

뮤테이션 한 번은 트랜잭션 하나입니다. 함수가 값을 돌려주면 쓴 것이 모두
저장되고, 오류가 나거나 `ctx.fail`을 부르거나 한도를 넘으면 아무것도 바뀌지
않습니다. 요청을 거절할 때는 `ctx.fail(코드, 메시지, 세부)`를 부르세요. 페이지가
받는 `error.message`는 사이트가 쓴 메시지 그대로(1~1000자)라 방문자에게 바로
보여 줄 수 있고, 세부(4 KiB 이하의 JSON)는 `error.details`로 전달되어 페이지가
이유에 따라 다르게 처리할 수 있습니다.

### 누가 불렀나

| 페이지에서                       | ctx.member | ctx.owner |
| -------------------------------- | ---------- | --------- |
| `naru.query()·naru.mutate()`     | null       | false     |
| `member.query()·member.mutate()` | `{ id }`   | false     |
| `admin.query()·admin.mutate()`   | null       | true      |

회원이 로그인해 있어도 `naru.query()`로 부르면 방문자로 부릅니다. 회원으로
부르려면 `member`의 메서드를 쓰세요.

### ctx

|                                              | 뜻                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `member · owner`                             | 누가 불렀는지 (위 표)                                                                                                                          |
| `ownerName`                                  | 사이트 주인의 나루 아이디 (누가 부르든)                                                                                                        |
| `now`                                        | 호출 시각(밀리초). 한 호출 안에서 바뀌지 않습니다.                                                                                             |
| `sql`                                        | 사이트 테이블에 SQL 한 문장을 실행합니다. 나루의 뷰 \_naru\_uploads(id, url, member, name, type, size, created\_at)도 읽고 조인할 수 있습니다. |
| `fail(코드, 메시지, 세부)`                   | 요청을 거절하고 쓴 것을 되돌립니다.                                                                                                            |
| `passwords.verify(비밀번호, 해시, 키)`       | 손님 비밀번호 확인                                                                                                                             |
| `passwords.hash(비밀번호)`                   | 손님 비밀번호의 해시 (뮤테이션만)                                                                                                              |
| `notify(회원ID 목록, { title, body, path })` | 회원에게 나루 앱 알림을 보냅니다 (뮤테이션만)                                                                                                  |

`ctx`의 메서드는 Promise를 돌려주므로 `await`하세요. `await`하지 않은 호출이
있으면 호출 전체가 실패하고 되돌려집니다. 인자 없이 부르면 인자는
`undefined`라서 `{ board } = {}`같은 기본값이 그대로 쓰입니다.

### ctx.sql

`` ctx.sql`SELECT … WHERE id = ${id}` ``처럼 태그로 쓰면 `${…}` 안의 값은 모두
매개변수로 묶이므로, 방문자가 보낸 값을 그대로 넣어도 SQL이 바뀌지 않습니다.
쿼리 빌더가 만든 문장은 `ctx.sql(문장, 값 목록)`으로 넘깁니다. 결과는
`{ rows, changes }`입니다.

- 한 번에 한 문장, `SELECT`·`INSERT`·`UPDATE`·`DELETE`(와 `WITH`·`RETURNING`)를
  씁니다. 쿼리에서는 `SELECT`만 됩니다. 테이블을 만들고 바꾸는 일은
  마이그레이션에서 합니다.
- 묶는 값은 문자열, 숫자, 불리언(1·0으로), `Uint8Array`(BLOB으로), null이며
  100개까지입니다. BLOB 열은 `Uint8Array`로 돌아옵니다. 한 문장은 1,000행·1
  MiB까지 돌려주니 `LIMIT`를 붙이세요.
- 나루의 테이블, PRAGMA, 트리거, 트랜잭션, 재귀 쿼리는 거절됩니다.
- 한 호출은 모두 합쳐 500,000행까지 읽습니다. 테이블이 커져도 빠르려면 테이블
  하나만 한 번 훑고, 다른 테이블은 조인하는 열에 색인을 만들어 같은 값으로
  찾으세요.
- 한 문장이 3초를 넘기면 멈추고 `INVALID_REQUEST`로 실패합니다. 쓰기였다면 그
  호출이 쓴 것은 모두 되돌려집니다. 같은 문장이 1분 안에 3번 멈추면 5분
  동안(1시간 안에 다시 그러면 30분) 실행하지 않고 바로 `UNAVAILABLE`로
  거절합니다(`error.details.reason`은 `"statement_paused"`). 사이트의 다른
  문장은 그대로 됩니다. 이렇게 중지된 쿼리는 관리 화면의 데이터베이스 페이지
  &lsquo;중지된 쿼리&rsquo;에 SQL과 함께 나오고, 거기서 다시 허용하거나 고친
  코드를 새로 릴리스하면 다시 실행됩니다.
- `UNIQUE` 열에 이미 있는 값을 쓰면 `CONFLICT`로 실패하고
  `error.details.unique`에 그 열 이름이 담깁니다. 닉네임 중복 같은 것을 이렇게
  알 수 있습니다. 그 밖의 SQL 실수는 SQLite의 설명과 함께 `INVALID_REQUEST`로
  실패합니다.

### 손님 글과 비밀번호

그누보드의 손님 글처럼, 방문자가 비밀번호를 걸어 글을 쓰고 나중에 같은
비밀번호로 고치거나 지우게 하려면 뮤테이션에서 `ctx.passwords.hash()`로 만든
해시를 테이블에 저장하고, `ctx.passwords.verify()`로 확인합니다. 비밀번호 자체는
어디에도 남지 않습니다.

```sql
-- _naru/migrations/0002_guestbook.sql
CREATE TABLE guestbook (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  password TEXT NOT NULL -- 해시만 저장됩니다
);
```

```
// _naru/mutations/guestbook.js
export async function write(ctx, { name, text, password }) {
  const hash = await ctx.passwords.hash(password);
  const { rows } = await ctx.sql`
    INSERT INTO guestbook (name, text, password)
    VALUES (${name}, ${text}, ${hash}) RETURNING id`;
  return rows[0].id;
}

export async function edit(ctx, { id, text, password }) {
  const [entry] = (await ctx.sql`SELECT password FROM guestbook WHERE id = ${id}`).rows;
  if (!entry || !(await ctx.passwords.verify(password, entry.password, `guestbook:${id}`)))
    ctx.fail("ACCESS_DENIED", "비밀번호가 맞지 않습니다.");
  await ctx.sql`UPDATE guestbook SET text = ${text} WHERE id = ${id}`;
}

// _naru/queries/guestbook.js: password 열은 돌려주지 않습니다.
export async function list(ctx) {
  return (await ctx.sql`SELECT id, name, text FROM guestbook ORDER BY id DESC LIMIT 50`).rows;
}

// 페이지에서, 로그인 없이
await naru.mutate("guestbook:write", { name: "손님", text: "안녕하세요", password });
```

`verify`의 세 번째 인자는 무엇을 여는 비밀번호인지를 나타내는
키입니다(`guestbook:42`처럼). 한 키에 틀린 비밀번호는 누가 시도하든 한 시간에 열
번까지이고, 그 뒤에는 맞는 비밀번호도 `RATE_LIMITED`로 실패하니, 짧은 비밀번호도
하나씩 맞혀 볼 수 없습니다. 한 번 부를 때 비밀번호 해시와 확인은 합쳐서 세
번까지입니다.

### 공통 코드와 타입

공통 코드는 `_naru/modules/`에 두고 상대 경로로 import하거나 다시 내보낼 수
있습니다. 경로에 `.js`를 포함하세요. 번들 생성은 필요하지 않습니다. 패키지
이름과 URL, 동적 import, 최상위 await는 지원하지 않습니다. 공통 모듈은
페이지에서 직접 부를 수 없습니다. `_naru/`의 파일은 방문자에게 공개되지 않으니,
페이지도 같은 코드를 써야 한다면 그 사본을 사이트의 다른 폴더에 함께 올리세요.

```
// _naru/modules/text.js
export const clean = (value, max) => String(value ?? "").trim().slice(0, max);

// _naru/mutations/comments.js
import { clean } from "../modules/text.js";
export async function add(ctx, { post, text }) {
  if (!ctx.member) ctx.fail("AUTH_REQUIRED", "회원만 댓글을 쓸 수 있습니다.");
  await ctx.sql`INSERT INTO comments (post, author, text, created_at)
    VALUES (${post}, ${ctx.member.id}, ${clean(text, 1000)}, ${ctx.now})`;
}
```

파일을 저장하거나 사이트를 설치하면 나루가 `_naru/`의 코드와 마이그레이션으로
릴리스를 만들고 적용합니다. import가 잘못되거나 마이그레이션이 실패하면 이전
릴리스가 계속 실행됩니다. 파일을 하나씩 올릴 때는 공통 모듈과 마이그레이션부터
올리세요. 한 호출은 같은 릴리스의 파일만 씁니다.

`ctx`의 타입은 [functions.d.ts](https://sdk.naru.pub/sdk/1.2.0/functions.d.ts)에
모두 적혀 있습니다. 내려받아 `_naru/types/`에 두고 JSDoc으로 쓰면 편집기가
`ctx`를 알아봅니다. 로컬 개발 서버 [naru-dev](/docs/dev)로 사이트를 돌리면 마이그레이션이
만든 테이블마다 행의 타입을 `_naru/types/database.d.ts`에 써 줍니다.

```
// _naru/queries/board.js
/** @type {import("../types/functions").Query<{ board: string }>} */
export const latest = async (ctx, { board }) =>
  (await ctx.sql`SELECT id, title FROM posts WHERE board = ${board} LIMIT 20`).rows;
```

사이트 코드는 브라우저나 Node가 아니라 QuickJS에서 돌아갑니다. 자바스크립트 기본
객체에 더해 `URL`, `URLSearchParams`, `structuredClone`, `Math.random()`,
`Date.now()`, `performance.now()`를 쓸 수 있습니다. `Intl`, `TextEncoder`,
`atob`/`btoa`, `crypto`, `console`, 네트워크와 타이머는 없습니다. 시각은
`ctx.now`를 쓰고, 서버의 지역 시간대가 한국이 아닐 수 있으니 UTC 메서드로
계산하세요. 사이트 코드 파일은 방문자에게 공개되지 않지만, GitHub에 올리거나
템플릿으로 나누면 함께 나가니 비밀값을 넣지 마세요.

## 10 · 실시간 쿼리 {#live}

5초마다 다시 읽는 대신 `subscribe()`로 쿼리를 들으세요. 나루가 쿼리를 바로 한 번
돌려 답을 주고, 그 뒤에 뮤테이션이 쿼리가 읽은 테이블을 바꿔 답이 달라질 때마다
새 답을 보냅니다. 방문자는 `naru.subscribe()`, 회원은 `member.subscribe()`로
듣고, 쿼리는 `query()`로 부를 때와 같은 사람으로 돕니다.

```
const live = naru.subscribe(
  "board:recent",
  {},
  (posts) => render(posts),
  { onError: (error) => (status.textContent = error.message) },
);

// 더 듣지 않을 때
live.close();
```

- 같은 페이지의 실시간 쿼리는 연결 하나를 나눠 쓰며, 연결 하나에 20개까지 들을
  수 있습니다. 마지막 쿼리를 닫으면 연결도 닫힙니다.
- 연결이 끊기면 스스로 다시 이어지고, 이어지면 모든 쿼리를 다시 물어 놓친 답을
  받습니다. 회원의 승인이 취소되거나 차단되면 연결이 닫힙니다.
- 처음 한 번은 쿼리 호출로 세고, 쓰기 뒤에 다시 도는 것은 세지 않습니다. 답이
  그대로이면 아무것도 보내지 않습니다.
- 사이트 테이블의 변경만 다시 돌게 합니다. 컬렉션은 실시간으로 들을 수 없습니다.
  새 릴리스가 적용되면 모든 실시간 쿼리가 다시 돕니다.
- 지금 실패하거나, 나중에 다시 돌다 실패한 것은 `onError`로 갑니다.

## 11 · 라우트 {#routes}

대부분의 페이지는 정적 HTML과 스크립트로 충분합니다. 다만 글 하나하나의 주소를
링크로 공유할 때 미리보기에 글 제목이 나오게 하거나, 검색 엔진과 RSS 리더에
내용을 보여 주려면 서버가 페이지를 그려야 합니다. 그럴 때 `_naru/routes.json`에
그 주소들을 적으면, 나루가 그 주소의 요청에 `_naru/routes.js`의 기본 내보내기를
돌려 답합니다. `routes.json`은 Cloudflare Pages의 `_routes.json`과 같은
형식입니다.

```
{
  "version": 1,
  "include": ["/", "/posts/*", "/feed.xml"],
  "exclude": ["/posts/drafts/*"]
}
```

`include`에 적은 주소가 `routes.js`를 돌리고(하나 이상), `exclude`에 적은 주소는
무엇이 포함하든 돌리지 않습니다. 주소는 `/`로 시작하고, `*`는 슬래시를 포함해
무엇이든 받습니다: `/posts/*`는 `/posts/`와 `/posts/a/b`를 받지만 `/posts`는
받지 않습니다. 규칙은 모두 합쳐 100개, 하나에 100자까지입니다. 라우트로 가는
주소는 같은 이름의 사이트 파일보다 라우트가 답하고, 나머지 주소는 전처럼 사이트
파일이 답합니다. `routes.json`과 `routes.js`는 함께 있어야 하며, 형식이 틀린
`routes.json`은 반영되지 않습니다.

```
// _naru/modules/html.js
export const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// _naru/routes.js
import { escape } from "./modules/html.js";

export default async function (ctx, { path, query }) {
  const [, kind, id] = path.split("/");
  if (kind !== "posts" || !/^\d+$/.test(id ?? ""))
    ctx.fail("NOT_FOUND", "없는 페이지입니다.");
  const [post] = (await ctx.sql`SELECT title, body FROM posts WHERE id = ${Number(id)}`).rows;
  if (!post) ctx.fail("NOT_FOUND", "글이 없거나 지워졌습니다.");
  return {
    type: "text/html",
    body: `<!doctype html>
<meta charset="utf-8">
<title>${escape(post.title)}</title>
<h1>${escape(post.title)}</h1>
<p>${escape(post.body)}</p>`,
    cache: 30,
  };
}
```

함수는 `{ path, origin, query }`를 받습니다. `path`는 요청된 그대로(퍼센트
인코딩된 채)이고, 어떤 페이지인지는 함수가 직접 읽습니다. `origin`은 방문자가 연
주소의 앞부분(`https://alice.naru.pub`이나 연결한 도메인)이라`og:url` 같은 절대
주소를 만들 때 씁니다. `query`는 주소의 `?` 뒤 값입니다. 라우트는 로그인과
상관없이 방문자의 쿼리로 돌아, `ctx.member`가 null, `ctx.owner`가 false이고
테이블을 읽기만 합니다. 회원에게만 보일 내용은 페이지의 스크립트에서
`member.query()`로 읽으세요. HTML에 넣는 값은 위의 `escape`처럼 직접
이스케이프해야 합니다.

| 돌려주는 값      | 응답                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"<h1>…"`        | 문자열은 HTML 페이지입니다.                                                                                                                                                                              |
| `{ body, type }` | HTML 페이지나 RSS·JSON 같은 글. `type`은 `text/html`·`application/rss+xml`·`application/atom+xml`·`application/json`·`application/xml`·`text/xml`·`text/plain`·`text/css`·`text/calendar` 중 하나입니다. |
| `{ file, head }` | 사이트 파일(예: `post.html`)을 그대로 보내되 `head`를 그 파일의 `<head>`에 넣습니다. 페이지는 스크립트가 그리고, 링크 미리보기용 `og:title` 같은 태그만 서버에서 넣을 때 씁니다.                         |
| `{ redirect }`   | 그 주소로 보냅니다. `/`로 시작하는 경로나 `https://` 주소이고, 기본 상태는 302입니다.                                                                                                                    |

객체에는 `status`(200~599)와 `cache`(0~300초)를 함께 넣을 수 있습니다. `cache`를
주면 나루가 그 시간 동안 같은 주소의 페이지를 다시 그리지 않고 보내므로,
그동안은 글이 바뀌어도 이전 페이지가 보입니다. `ctx.fail`을 부르면 그 상태
코드와 메시지로 오류 페이지를 보냅니다. 라우트는 `GET` 요청에만 답하니, 글쓰기는
페이지의 스크립트에서 뮤테이션으로 하세요.

```
// 글은 post.html의 스크립트가 그리고, 미리보기 태그만 넣습니다.
return {
  file: "post.html",
  head: `<meta property="og:title" content="${escape(post.title)}">`,
  cache: 60,
};
```

## 12 · 사용 예 {#recipes}

### 블로그 글 공개

posts · 읽기 누구나 / 쓰기 관리자만

```js
naru
  .collection("posts")
  .list({
    sort: [["date", "desc"]],
  });
// 글 페이지: post.html?id=hello
const id = new URLSearchParams(location.search)
  .get("id");
const post = await naru.collection("posts").get(id);
```

### 방명록

guestbook · 읽기 누구나 / 쓰기 누구나 생성만

```js
naru.collection("guestbook")
  .add({ name, message });
naru.collection("guestbook")
  .list({
    sort: [[{ metadata: "createdAt" }, "desc"]],
  });
```

### 비공개 문의 받기

inquiries · 읽기 관리자만 / 쓰기 누구나 생성만

```js
naru.collection("inquiries")
  .add({ email, message });
```

### 초안 저장 후 공개

drafts · 읽기 관리자만 / 쓰기 관리자만

```js
admin.batch([
  { collection: "posts",
    set: { id, data, condition: { absent: true } } },
  { collection: "drafts",
    delete: { id, condition: { revision: draft.revision } } },
]);
```

### 글에 이미지 붙이기

[미디어 라이브러리](/docs/1.2.0/media) · 관리자 업로드

```js
const image =
  await admin.media.upload(file);
const posts = admin.collection("posts");
const post = await posts.get(id);
await posts.set(id, { ...post.data, cover: image.url },
  { condition: { revision: post.revision } });
```

### 특정 글의 익명 댓글

comments · 읽기 누구나 / 쓰기 누구나 생성만

```js
naru.collection("comments")
  .add({ postId: "hello", name, message });
naru
  .collection("comments")
  .list({
    filter: { postId: "hello" },
  });
```

### 회원 게시판

posts 테이블 · [쿼리와 뮤테이션](#code)

```js
await member.mutate("board:write",
  { title, body });
naru.subscribe("board:recent", {},
  (posts) => render(posts));
```

### 게시판 검색

posts 테이블 · \_naru/queries/board.js

```js
export async function search(ctx, { word }) {
  return (await ctx.sql`
    SELECT id, title FROM posts
    WHERE title LIKE '%' || ${word} || '%'
    ORDER BY id DESC LIMIT 20`).rows;
}
```

### 회원 사진 올리기

[미디어](/docs/1.2.0/media) · 회원 업로드

```js
const image =
  await member.media.upload(file);
await member.mutate("board:write",
  { title, body, image: image.url });
```

### 손님 비밀글

guestbook 테이블 · [ctx.passwords](#code)

```js
await naru.mutate("guestbook:edit",
  { id, text, password });
```

바로 시작할 수 있는 사이트가 필요하면
[데이터베이스를 쓰는 템플릿](/templates?database=1)을 둘러보세요.

## 13 · 한도와 오류 {#errors}

- 사이트당 컬렉션 100개, 문서 100,000개, 데이터는 컬렉션과 사이트 테이블을 합쳐
  100 MiB. 컬렉션 요청 하나는 64 KiB까지입니다.
- 방문자의 컬렉션 `add`는 분당 횟수가 제한됩니다.
- 쿼리와 라우트는 읽기로 세어, 컬렉션 읽기와 합쳐 회원이나 주소마다 분당
  600번까지입니다.
- 미디어 업로드는 회원마다 한 시간에 30개, 방문자는 사이트마다 주소당 한
  시간에 10개, 사이트의 방문자 모두 합쳐 한 시간에 100개까지입니다.
- 뮤테이션은 회원마다 분당 30번, 방문자는 주소마다 분당 20번, 사이트 전체에서
  분당 300번까지입니다. 소유자의 호출은 세지 않습니다.
- 사이트 코드 한 번은 데이터베이스 작업(`ctx.sql` 한 문장 한 번씩) 100번,
  `Math.random()` 2,000번, 비밀번호 해시와 확인 3번, 수십 밀리초, 메모리 32
  MiB까지 쓰고, 돌려주는 값은 JSON으로 1 MiB까지입니다.
- 사이트 코드 파일은 하나에 256 KiB, 모두 256개까지입니다.
- 관리자 로그인 페이지는 사이트당 20개까지 등록합니다.

실패하면 `NaruError`를 던집니다. 방문자에게는 `error.message`를 보여 주세요.
나루의 오류는 한국어로 적혀 있고, 사이트 코드의 `ctx.fail`은 그 메시지
그대로입니다. 무엇이 왜 실패했는지 자세한 설명은 영어로 응답에 있으니, 막히면
브라우저 개발자 도구의 네트워크 탭에서 확인하세요. 처리를 나눌 때는 `code`를
쓰세요.

| code              | 뜻                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `NOT_FOUND`       | 문서, 컬렉션, 쿼리·뮤테이션 또는 사이트가 없습니다.                                                             |
| `ACCESS_DENIED`   | 공개 범위나 등록된 컬렉션이 허용하지 않거나, 회원이 승인 대기·차단 상태이거나(error.details.membership), 사이트가 방문자 업로드를 받지 않습니다. |
| `AUTH_REQUIRED`   | 관리자나 회원의 로그인이 만료되었습니다. 다시 로그인하세요.                                                     |
| `CONFLICT`        | condition이 맞지 않거나, unique 필드나 UNIQUE 열의 값이 이미 쓰이고 있습니다(error.details.unique).             |
| `QUOTA_EXCEEDED`  | 데이터나 미디어 저장 공간이 가득 찼습니다.                                                                      |
| `RATE_LIMITED`    | 요청이 너무 많거나, 틀린 비밀번호가 너무 많습니다. 잠시 후 다시 시도하세요.                                     |
| `INVALID_REQUEST` | 이름, 필터, 크기, SQL 등 요청 형식이 잘못되었거나 사이트 코드가 한도를 넘었습니다.                              |
| `UNAVAILABLE`     | 일시적인 오류입니다. 나루 서버가 잠시 대기 서버로 넘어가 있는 동안에는 읽기만 되고 쓰기는 이 오류로 실패합니다. |

사이트 코드의 `ctx.fail`은 위의 코드 중 하나를 골라 씁니다. 같은 코드라도
메시지와 세부는 사이트가 정합니다.

```
try {
  await naru.collection("guestbook").add({ message });
} catch (error) {
  status.textContent = error.message; // 예: "요청이 너무 많습니다. 잠시 뒤에 다시 해 주세요."
}
```
