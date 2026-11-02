---
title: 정적 웹사이트에 데이터를 더하세요.
pageTitle: 데이터베이스 사용 안내 | 나루
description: 나루 제어판과 웹 SDK로 블로그, 방명록, 관리자 글쓰기를 만드는 방법
path: DATABASE / SDK 1.0.0
links: [데이터베이스 제어판 열기 →](/database) [데이터베이스 템플릿 둘러보기 →](/board?kind=template&database=1) [SDK 레퍼런스 →](/docs/sdk/1.0.0)
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
  import { createNaru } from "https://sdk.naru.pub/sdk/1.0.0/naru.js";
  const naru = createNaru({ site: "{{site}}" });
  const { documents } = await naru.collection("posts").list();
  for (const post of documents) {
    const item = document.createElement("li");
    item.textContent = post.data.title;
    document.querySelector("#posts").append(item);
  }
</script>
```

`createNaru()`에는 늘 `site`로 나루 아이디를 넘기세요(이 예제에서는
`{{site}}`). `아이디.naru.pub`에서는 없어도 되지만, 없으면 커스텀 도메인이나 내
컴퓨터에서 연 페이지에서는 어느 사이트인지 몰라 오류가 납니다.

### 방명록에 인사 남기기

제어판에서 `guestbook` 컬렉션을 만들고 읽기는 ‘누구나’, 쓰기는 ‘누구나
생성만’으로 설정하세요.

```html
<button id="hello">인사 남기기</button>
<p id="result"></p>
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1.0.0/naru.js";
  const naru = createNaru({ site: "{{site}}" });
  const button = document.querySelector("#hello");
  const result = document.querySelector("#result");
  button.onclick = async () => {
    button.disabled = true;
    try {
      const saved = await naru.collection("guestbook").add({
        name: "방문자",
        message: "안녕하세요!",
      });
      result.textContent = saved.data.message + " 저장됨";
    } catch (error) {
      result.textContent = "결과를 확인하지 못했습니다. 방명록을 확인하세요.";
      console.error(error);
    }
  };
</script>
```

방문자가 쓴 글은 `textContent`로 넣으세요. `innerHTML`로 넣으면 글에 섞인
스크립트가 내 페이지에서 실행됩니다.

## 02 · 컬렉션과 공개 범위 {#collections}

**컬렉션**은 문서를 모으는 곳이고, **문서**는 ID 하나와 JSON 데이터
하나입니다. 이름과 문서 ID는 영문·숫자·`_`·`-` 1~64자입니다.

|      | 설정                      | 방문자가 할 수 있는 일                                              |
| ---- | ------------------------- | ------------------------------------------------------------------- |
| 읽기 | 관리자만                  | 방문자는 읽을 수 없습니다.                                          |
| 읽기 | 누구나                    | `get`·`list`·`count`·`pages`로 누구나 읽습니다.                     |
| 쓰기 | 관리자만                  | 방문자는 쓸 수 없습니다.                                            |
| 쓰기 | 누구나 생성만             | `add`로 새 문서만 만듭니다. 방명록에 알맞습니다.                    |
| 쓰기 | 누구나 생성·덮어쓰기·삭제 | 누구나 모든 문서를 바꾸고 지울 수 있습니다. 대부분은 필요 없습니다. |

관리자는 [로그인](#admin)하면 등록한 컬렉션을 공개 범위와 상관없이 읽고 쓸 수
있습니다. 공개 읽기 컬렉션의 문서는 누구나 읽을 수 있으니, 비공개로 둘 데이터는
‘관리자만’ 읽는 컬렉션에 따로 저장하세요.

### 파일로 컬렉션 정하기

제어판 대신 사이트의 `_naru/collections.json`에 페이지가 쓰는 컬렉션을 적어 둘
수도 있습니다. 파일을 저장하면 없는 컬렉션이 적힌 대로 바로 만들어집니다. 이미
있는 컬렉션의 공개 범위나 `unique`를 바꾸는 내용은 [제어판](/database)에서
승인해야 반영됩니다. `read`는 `admin`(관리자만)이나 `world`(누구나), `write`는
`admin`, `create`(누구나 생성만), `world`(누구나 생성·덮어쓰기·삭제)입니다.

```json
{
  "collections": {
    "guestbook": { "read": "world", "write": "create" },
    "settings": { "read": "admin", "write": "admin" }
  }
}
```

`unique`(서로 겹치면 안 되는 필드, 3개까지)와 `indexes`(자주 거르거나 정렬하는
필드, 5개까지)도 적을 수 있습니다.

## 03 · 관리자 로그인 {#admin}

나루 홈페이지의 소유자가 로그인하면 홈페이지에 로그인할 수 있습니다.

1. 제어판의 ‘웹사이트 관리자 로그인’에 관리자 페이지 주소(예:
   `https://{{site}}.naru.pub/`)와 쓸 컬렉션을 등록합니다.
2. `naru.auth.signIn()`으로 로그인하고 `naru.auth.session()`으로 관리자
   클라이언트를 받습니다.

```html
<button id="login">관리자 로그인</button>
<p id="auth-status"></p>
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1.0.0/naru.js";
  const naru = createNaru({ site: "{{site}}" });
  const admin = await naru.auth.session();
  const login = document.querySelector("#login");
  login.hidden = !!admin;
  document.querySelector("#auth-status").textContent = admin
    ? "로그인되었습니다."
    : "글을 고치려면 로그인하세요.";
  login.onclick = () => naru.auth.signIn({ collections: ["posts", "drafts"] });
  // 다음 예제의 owner는 이 스크립트 안에서 사용하세요.
</script>
```

## 04 · 글 수정과 충돌 처리 {#write}

| 호출                           | 동작                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `add(data)`                    | 새 ID로 문서를 만듭니다.                                         |
| `set(id, data, { condition })` | 그 ID의 문서를 만들거나 통째로 바꿉니다. 필드를 합치지 않습니다. |
| `delete(id, { condition })`    | 문서를 지웁니다. 없는 문서를 지워도 성공합니다.                  |

`condition`으로 덮어쓰기를 막을 수 있습니다. `{ revision }`은 읽은 뒤 바뀌지
않았을 때만, `{ absent: true }`는 아직 없는 문서일 때만 저장하고, 아니면
`CONFLICT`로 실패합니다.

```javascript
const post = await admin.collection("posts").get("hello");
try {
  await admin
    .collection("posts")
    .set(
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

`admin.batch()`은 여러 컬렉션의 `set`·`delete`를 최대 100개까지 묶어,
원자적으로 반영합니다. 각 변경의 condition도 함께 검사합니다. 미리 읽은 값이
저절로 보호되는 것은 아니므로 고치는 문서의 revision을 넘기세요. 결과는 쓴
순서대로, `set`은 `{ id, revision, createdAt, updatedAt }`, `delete`는
`null`입니다.

```javascript
const [saved] = await admin.batch([
  { collection: "posts", set: { id, data: post, condition: { absent: true } } },
  {
    collection: "drafts",
    delete: { id, condition: { revision: draft.revision } },
  },
]);
// saved.revision → 다음 저장의 condition
```

## 05 · 목록과 페이지 나누기 {#read}

```javascript
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
  날짜에서 최신 글을 먼저 보려면
  `[["date", "desc"], [{ metadata: "createdAt" }, "desc"]]`처럼 두 키를 씁니다.
  문자열은 언어별 정렬 없이 유니코드 순서로, 숫자는 크기로 비교합니다.
  오름차순에서 없는 값·null·배열·객체, 문자열, 숫자, 불리언 순입니다.
- **size**: 한 번에 기본 50개, 최대 100개입니다. 다음 페이지는 같은
  filter·sort에 `nextCursor`를 `after`로 넘기고, `nextCursor`가 `null`이면
  끝입니다. `includeTotal: true`면 전체 개수도 받습니다. 개수만 필요하면
  `count()`를, 모든 쪽이 필요하면 `pages()`를 쓰세요. 누구나 쓸 수 있는
  컬렉션은 끝까지 읽지 말고 필요한 만큼만 받으세요.

## 06 · 사용 예 {#recipes}

### 블로그 글 공개

`posts` · 읽기 누구나 / 쓰기 관리자만

```javascript
naru.collection("posts").list({
  sort: [["date", "desc"]],
});
```

### 방명록

`guestbook` · 읽기 누구나 / 쓰기 누구나 생성만

```javascript
naru.collection("guestbook").add({ name, message });
```

### 비공개 문의 받기

`inquiries` · 읽기 관리자만 / 쓰기 누구나 생성만

```javascript
naru.collection("inquiries").add({ email, message });
```

### 초안 저장 후 공개

`drafts` · 읽기 관리자만 / 쓰기 관리자만

```javascript
admin.batch([
  { collection: "posts", set: { id, data, condition: { absent: true } } },
  {
    collection: "drafts",
    delete: { id, condition: { revision: draft.revision } },
  },
]);
```

### 글에 이미지 붙이기

[미디어 라이브러리](/docs/1.0.0/media) · 관리자 업로드

```javascript
const image = await admin.media.upload(file);
const posts = admin.collection("posts");
const post = await posts.get(id);
await posts.set(
  id,
  { ...post.data, cover: image.url },
  { condition: { revision: post.revision } },
);
```

### 특정 글의 댓글

`comments` · 읽기 누구나 / 쓰기 누구나 생성만

```javascript
naru.collection("comments").list({
  filter: { postId: "hello" },
});
```

바로 시작할 수 있는 사이트가 필요하면
[데이터베이스를 쓰는 템플릿](/templates?database=1)을 둘러보세요.

## 07 · 한도와 오류 {#errors}

- 사이트당 컬렉션 100개, 문서 100,000개, 데이터 100 MiB. 요청 하나는 64
  KiB까지입니다.
- 방문자의 `add`는 분당 횟수가 제한됩니다.
- 관리자 로그인 페이지는 사이트당 20개까지 등록합니다.

실패하면 `NaruError`를 던집니다. `code`로 구분하세요.

| code              | 뜻                                               |
| ----------------- | ------------------------------------------------ |
| `NOT_FOUND`       | 문서, 컬렉션 또는 사이트가 없습니다.             |
| `ACCESS_DENIED`   | 공개 범위나 등록된 컬렉션이 허용하지 않습니다.   |
| `AUTH_REQUIRED`   | 관리자 권한이 만료되었습니다. 다시 로그인하세요. |
| `CONFLICT`        | condition이 맞지 않습니다.                       |
| `QUOTA_EXCEEDED`  | 데이터나 미디어 저장 공간이 가득 찼습니다.       |
| `RATE_LIMITED`    | 요청이 너무 많습니다. 잠시 후 다시 시도하세요.   |
| `INVALID_REQUEST` | 이름, 필터, 크기 등 요청 형식이 잘못되었습니다.  |
| `UNAVAILABLE`     | 일시적인 오류입니다.                             |

```javascript
try {
  await naru.collection("guestbook").add({ message });
} catch (error) {
  status.textContent =
    error.code === "RATE_LIMITED" ? "잠시 후 다시 시도하세요." : error.message;
}
```
