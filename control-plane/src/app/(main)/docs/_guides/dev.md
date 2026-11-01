---
title: 사이트를 내 컴퓨터에서 돌려 보세요.
pageTitle: 로컬 개발 | 나루
description: naru-dev로 나루 사이트와 Data SDK, 사이트 코드를 내 컴퓨터에서 실행하고 시험하는 방법
path: NARU-DEV
links: [npm에서 보기 →](https://www.npmjs.com/package/@naru-pub/dev) [데이터베이스 사용 안내 →](/docs/1.1.0/database) [영문 설명서 →](https://github.com/naru-pub/naru/tree/main/naru-dev)
---

naru-dev는 나루 사이트를 내 컴퓨터에서 실행하는 개발 서버입니다.
`sdk.naru.pub`을 돌리는 것과 같은 엣지 코드로 페이지, Data SDK, `_naru/`의 사이트
코드를 실행합니다. 나루 계정이나 저장소는 없어도 되고, 한 번 설치하면
오프라인에서도 돌아갑니다.

## 01 · 실행하기 {#start}

사이트 폴더를 넘겨 실행하세요. Node.js 20 이상이 필요하고, macOS와 Linux(arm64,
x64), Windows(x64)에서 돌아갑니다.

```bash
npx @naru-pub/dev ./site --site demo
# naru-dev: demo at http://localhost:4000/
```

`./site`는 예시입니다. `index.html`이 있는 내 사이트 폴더를 넘기세요. 프로젝트에
넣어 두고 쓸 수도 있습니다.

```bash
npm install --save-dev @naru-pub/dev
npx naru-dev ./site --site demo
```

| 옵션            | 기본값                    | 하는 일                      |
| --------------- | ------------------------- | ---------------------------- |
| `--site <name>` | `localsite`               | 사이트의 나루 이름           |
| `--port <port>` | `4000`                    | 포트, `0`이면 비어 있는 포트 |
| `--state <dir>` | `<사이트 폴더>/.naru-dev` | 데이터를 두는 폴더           |
| `--quiet`       |                           | 주소만 출력                  |
| `--version`     |                           | 버전을 출력하고 종료         |

## 02 · 페이지와 사이트 코드 {#site}

페이지는 고칠 필요가 없습니다. `https://sdk.naru.pub/sdk/1.1.0/naru.js`를 그대로
가져오면 naru-dev가 내 컴퓨터의 SDK로 연결하고, 같은 페이지가 나루에서도 그대로
돌아갑니다.

```html
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1.1.0/naru.js";
  const naru = createNaru();
  const posts = await naru.query("board:recent");
</script>
```

`_naru/`의 파일은 시작할 때, 그리고 고칠 때마다 다시 게시되고 마이그레이션이
적용됩니다. `_naru/collections.json`도 고치면 바로 반영됩니다. 사이트 코드를
쓰는 방법은 [데이터베이스 사용 안내](/docs/1.1.0/database)를 보세요.

게시할 때마다 마이그레이션이 만든 테이블의 행 타입을
`_naru/types/database.d.ts`에 씁니다. `ctx.sql`과 쿼리 빌더에서 편집기의 도움을
받을 수 있습니다.

## 03 · 로그인 {#sign-in}

나루 계정 없이 클릭 한 번으로 로그인합니다.

- `naru.auth.signIn()`은 사이트 운영자로 로그인합니다. 요청한 컬렉션이 없으면
  나루에서처럼 비공개로 만듭니다.
- `naru.members.signIn()`은 시험용 회원을 고르거나 새로 만드는 페이지를 엽니다.
  회원의 상태(승인, 대기, 차단)도 고를 수 있습니다.

## 04 · 데이터 {#data}

데이터, 올린 파일, 회원, 로그인은 사이트 폴더의 `.naru-dev/`에 남아 다시
실행해도 그대로입니다. 지우면 빈 사이트로 다시 시작합니다.

폴더는 `.gitignore`에 넣으세요. 올린 파일은 페이지에서
`https://media.naru.pub/...` 주소를 그대로 쓰고, naru-dev가 페이지에 설치하는
서비스 워커가 내 컴퓨터에서 돌려줍니다.

## 05 · 빌드하는 사이트 {#build}

번들러를 쓴다면 소스 폴더가 아니라 빌드 결과를 넘기세요. `index.html`과 `_naru/`가
결과 폴더에 있어야 합니다. 빌드가 결과 폴더를 비우는 경우가 많으니 데이터는
`--state`로 그 밖에 두세요.

```bash
npm run build
npx @naru-pub/dev dist --site demo --state .naru-dev
```

naru-dev는 결과 폴더의 파일을 돌려주므로, 소스를 고치면 다시 빌드해야 합니다.

## 06 · 테스트 {#test}

`@naru-pub/dev/testing`의 `startNaru()`는 같은 서버를 테스트 안에서 비어 있는
포트와 임시 폴더로 띄우고, 클릭 없이 로그인합니다.

```js
import { startNaru } from "@naru-pub/dev/testing";
import { chromium } from "playwright";

const naru = await startNaru({ site: "./site", name: "demo", quiet: true });
const browser = await chromium.launch();
try {
  const owner = await browser.newContext();
  await naru.signIn(owner, "owner");
  const page = await owner.newPage();
  await page.goto(naru.url("/admin/"));

  const alice = await browser.newContext();
  await naru.signIn(alice, "alice");

  await naru.reset(); // 빈 사이트로, 마이그레이션은 적용된 채
} finally {
  await browser.close();
  await naru.stop();
}
```

`signIn()`의 두 번째 인자는 `"owner"`나 회원 이름이고, 없는 회원은 새로 만듭니다.
Playwright의 `Page`나 `BrowserContext` 대신 `null`을 넘기면 `{ headers }`를
돌려주니 데이터 API를 직접 부를 수 있습니다. `reset()`은 컬렉션, 테이블, 올린
파일을 비우고 `_naru/`를 다시 게시합니다. 회원과 로그인은 남습니다.

## 07 · 나루와 다른 점 {#differences}

컬렉션과 규칙, 테이블, 쿼리, 뮤테이션, 라우트, 실시간 쿼리, QuickJS와 그 한도는
나루와 똑같이 동작합니다. 다음은 naru-dev에 없으니 나루에 올려서 확인하세요.

- 결제와 서포터 플랜 (회원은 누구나 로그인할 수 있습니다)
- 미디어의 용량, 개수, 형식 검사
- 커스텀 도메인
- 나루의 로그인과 동의 화면
- 미디어 라이브러리
- 매일 만드는 복원 지점
- SQL 문 하나의 SQLite 실행 시간 제한

주소별 읽기 한도도 풀려 있습니다. 내 컴퓨터의 탭은 모두 같은 주소이기 때문입니다.

## 08 · 버전 {#versions}

패키지의 메이저와 마이너 버전은 제공하는 가장 새로운 SDK를 따릅니다. 1.1.x는 SDK
1.0.0과 1.1.0을 제공합니다. `naru-dev --version`은 그 릴리스를 빌드한 나루 커밋을
알려 줍니다.
