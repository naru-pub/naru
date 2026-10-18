# @naru-pub/dev

Run and test a [Naru](https://naru.pub) site on your own machine: its pages,
the Data SDK, and its site code (`_naru/` migrations, queries, mutations,
routes, live queries) on the same edge Worker that serves `sdk.naru.pub`,
with one-click owner and member sign-in. No Naru account or checkout is
needed, and once installed it runs offline.

```bash
npx @naru-pub/dev ./site --site demo
# naru-dev: demo at http://localhost:4000/
```

Requires Node.js 20 or later, on macOS or Linux (arm64 or x64), where it is
tested. [workerd](https://www.npmjs.com/package/workerd), which it runs,
also ships a Windows x64 binary, but naru-dev is not tested there.

## Install

Run it once with `npx @naru-pub/dev`, or add it to a project:

```bash
npm install --save-dev @naru-pub/dev
npx naru-dev ./site --site demo
```

## The command

```
naru-dev [site folder] [options]

  --site <name>   the site's Naru name (<name>.naru.pub); default localsite
  --port <port>   default 4000; 0 picks a free one
  --state <dir>   where data is kept; default <site folder>/.naru-dev
  --quiet         print only the address
  --version       print the version and exit
```

It prints its version, the Naru commit it was built from and the SDK
versions it serves, then serves the folder on `http://localhost:<port>`:

- **Pages** as they are, with an import map added to each HTML page, so
  `import ... from "https://sdk.naru.pub/sdk/1.1.0/naru.js"` (and `/sdk/1/`,
  `/sdk/1.0.0/`) loads this machine's SDK, pointed at this server. Keep the
  real URLs in your pages; they work unchanged on Naru.
- **`_naru/`**: every file is published at start and again whenever one
  changes, migrations applied; `_naru/collections.json` is installed,
  changes included. After each publication it writes
  `_naru/types/database.d.ts`, the site's tables as interfaces for `ctx.sql`
  and query builders.
- **Sign-in**: `naru.auth.signIn()` signs the owner in on one click
  (collections it asks for are made private if missing, as on Naru);
  `naru.members.signIn()` opens a page to pick or name a test member and
  their status (approved, pending, banned).
- **Uploads** keep their `https://media.naru.pub/...` addresses; a service
  worker on your pages serves them from `<state>/media/`.

Data, uploads, members and sign-ins are kept in `<site folder>/.naru-dev/`
(add it to `.gitignore`) and survive restarts. Delete the folder to start
over.

## Testing

`@naru-pub/dev/testing` starts the same server inside your test, on a free
port with a temporary state, and signs people in without clicking:

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
  // ...the page finds the owner's session, as after a real sign-in.

  const alice = await browser.newContext();
  await naru.signIn(alice, "alice");

  // Or call the data API yourself:
  const { headers } = await naru.signIn(null, "bob");
  await fetch(naru.url("/api/data/v1/demo/_mutate/notes:add"), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ args: { text: "hi" } }),
  });

  await naru.reset(); // an empty site again, migrations applied
} finally {
  await browser.close();
  await naru.stop();
}
```

`startNaru(options)` resolves once the site answers. Options:

| Option  | Default           | What                                                     |
| ------- | ----------------- | -------------------------------------------------------- |
| `site`  | (required)        | The site's folder                                        |
| `name`  | `localsite`       | The site's Naru name                                     |
| `port`  | `0` (a free port) | Where to serve                                           |
| `state` | a new temp folder | Where data is kept; a temp folder is removed by `stop()` |
| `quiet` | `false`           | Print nothing (`log` still has it)                       |

It returns:

- `origin`, such as `http://localhost:53412`, and `url(path)`;
- `signIn(target, who, { status, collections })`: `who` is `"owner"` or a
  member's name (made if new, `status` kept). Given a Playwright `Page` or
  `BrowserContext` (anything with `addInitScript`; Playwright is not a
  dependency), its pages on this origin find the session where the SDK keeps
  it from their next navigation, and at once for a page already there.
  Resolves `{ accessToken, expiresAt, memberId, headers }` either way;
- `reset()`: empties the site's collections, tables and uploads and
  publishes `_naru/` again; members and sign-ins stay;
- `stop()`; `log`, everything it printed; `name`; `state`.

## What's emulated, and what isn't

The site's data runs on Naru's own edge Worker (the code that serves
`sdk.naru.pub`) under workerd, with SQLite-backed Durable Objects: the
collections and their rules, the site's tables, queries, mutations, routes
and live queries, the QuickJS runtime and its limits, revision conditions
and batches, behave as on Naru. A process in front stands in for naru.pub's
part.

Not emulated: payments and supporter plans (every member may sign in),
the control plane's quotas and checks on media (size, counts, types),
custom domains, Naru's sign-in and consent pages, the media library, the
daily restore points, and the per-statement SQLite time budget of Naru's
own workerd build. The per-address read limit is lifted, since every
tab on your machine is one address. The site is always served at its own
origin, as on `<name>.naru.pub`.

## Versioning

The package's major and minor follow the Data SDK's newest version it
serves: 1.1.x serves SDK 1.0.0 and 1.1.0. Patch releases follow Naru's
server; `naru-dev --version` names the Naru commit a release was built from.

## Publishing

From the Naru repository (maintainers): set `version` in
`naru-dev/package.json`, commit, and push a tag `dev-v<version>`;
`.github/workflows/publish-naru-dev.yml` builds, checks and publishes it
with the `NPM_TOKEN` secret. `scripts/check-package.sh <dir>` does the
same check locally.

## License

[AGPL-3.0-only](LICENSE), as Naru. The SDK files it serves are Naru's; your
site is your own.

## 한국어

`@naru-pub/dev`는 나루 사이트를 내 컴퓨터에서 실행하고 시험하는 도구입니다.
`npx @naru-pub/dev ./site --site demo`를 실행하면 http://localhost:4000 에서
사이트 파일과 데이터 SDK, `_naru/`의 마이그레이션·쿼리·뮤테이션·라우트·실시간
쿼리를 `sdk.naru.pub`과 같은 엣지 Worker로 제공합니다. 운영자와 회원
로그인은 한 번의 클릭으로 끝나고, `_naru/`를 고치면 바로 다시 게시합니다.
데이터는 사이트 폴더의 `.naru-dev/`에 남습니다.

테스트에서는 `@naru-pub/dev/testing`의 `startNaru()`로 빈 포트와 임시 폴더에
서버를 띄우고, `signIn(page, "owner")`나 `signIn(page, "회원이름")`으로 클릭
없이 로그인합니다. 결제, 미디어 용량 제한, 커스텀 도메인, 나루의 로그인·동의
화면은 흉내 내지 않습니다. 라이선스는 AGPL-3.0-only입니다.
