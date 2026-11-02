---
title: 템플릿을 만들어 나눠 보세요.
pageTitle: 템플릿 | 나루
description: 사이트 코드와 Data SDK로 템플릿을 만들어 공개하는 방법, 업데이트해도 남는 것
path: TEMPLATES
links: [새 템플릿 공개하기 →](/board/new?kind=template) [내 템플릿 →](/developers)
---

사이트 코드(`_naru/`)와 Data SDK로 템플릿을 만들어 나누는 방법이에요. 빈 폴더에서
공개한 템플릿까지 세 단계예요. 여기서는 게시판 글 목록을 보여 주는 템플릿을 하나
만들어요.

## 01 · 테이블과 쿼리를 써요 {#tables}

마이그레이션이 테이블을 만들고, 쿼리가 읽어서 페이지에 돌려줘요. 페이지는 SDK
주소를 그대로 가져와서 빌드가 필요 없어요.

```sql
-- _naru/migrations/0001_posts.sql
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

```javascript
// _naru/queries/board.js
export async function recent(ctx) {
  const { rows } = await ctx.sql`
    SELECT id, title FROM posts ORDER BY id DESC LIMIT 20`;
  return rows;
}
```

```html
<!-- index.html -->
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1.1.0/naru.js";
  const naru = createNaru();
  const posts = await naru.query("board:recent");
</script>
```

자세한 내용은 [데이터베이스 사용 안내](/docs/1.1.0/database)를 보세요. 번들러와
타입 검사를 쓴다면 npm 패키지
[@naru-pub/sdk](https://github.com/naru-pub/naru/tree/main/sdk)도 있어요.

```bash
npm install @naru-pub/sdk
```

## 02 · 내 컴퓨터에서 돌려 봐요 {#local}

naru-dev가 나루와 같은 엣지에서 페이지와 `_naru/`를 돌려요. 파일을 고치면 바로 다시
게시하고, 운영자와 회원 로그인은 클릭 한 번이에요.

```bash
npx @naru-pub/dev ./site --site demo
# naru-dev: demo at http://localhost:4000/
```

자세한 내용은 [로컬 개발](/docs/dev)을 보세요.

## 03 · 템플릿으로 공개해요 {#publish}

[게시판에 템플릿 글](/board/new?kind=template)을 쓰고, 내 사이트의 폴더나 GitHub
저장소를 골라요. GitHub에서 공개하면 워크플로가 돌 때마다 새 버전이 올라가고, 커밋
메시지가 버전 설명이 돼요. `template-owner`에는 내 나루 아이디를 쓰세요. 워크플로는
[naru-pub/actions](https://github.com/naru-pub/actions)를 써요.

```yaml
# .github/workflows/naru.yml
permissions:
  id-token: write
steps:
  - uses: naru-pub/actions/deploy@v1
    with:
      dir: site
      template-owner: demo
```

템플릿을 설치하면 `_naru/`도 함께 복사돼요.

태그를 3개까지 달면 [템플릿 스토어](/templates)에서 태그로 찾을 수 있어요. 글을 쓸 때
달거나, 나중에 글 고치기에서 바꿀 수 있어요.

## 04 · 업데이트해도 남게 하기 {#updates}

템플릿을 설치한 사람이 새 버전으로 업데이트하면, 그 사람이 고친 파일은 보관된 뒤
바뀌어요. 자세한 규칙은 [템플릿 쓰기](/docs/using-templates#updates)를 보세요.
`/{{owner}}/` 폴더는 사이트 주인의 것이라서, 템플릿은 이 폴더에 파일을 넣을 수 없어요.

사이트 주인이 바꿀 만한 것은 파일이 아닌 곳에 두세요. 사이트 이름, 색, 메뉴, 안내
글처럼 운영 화면에서 정하는 것은 데이터베이스에 저장하면 업데이트와 상관없이
남아요. 파일로 고치게 하려면 템플릿의 스타일과 스크립트 뒤에 `/{{owner}}/`의 파일을
불러오세요. 파일이 없으면 그 요청은 404로 끝나니, 운영 화면에서 켜고 끄게 해도 돼요.

```html
<link rel="stylesheet" href="/{{owner}}/style.css" />
<script type="module" src="/{{owner}}/script.js"></script>
```
