# Claude directory listings

Naru is listed in Anthropic's Claude directory twice, as Anthropic asks for a
plugin that uses its own MCP server: the **Naru connector** (the server at
`https://naru.pub/mcp`) and the **Naru plugin** (the connector plus the
`naru-site` skill, from [naru-pub/claude-plugin](https://github.com/naru-pub/claude-plugin)).
Both are submitted at [claude.ai/directory/manage](https://claude.ai/directory/manage),
from a paid Claude plan, connector first. This page is what the portal asks
for, ready to paste.

Requirements: [connector submission](https://claude.com/docs/connectors/building/submission),
[connector review criteria](https://claude.com/docs/connectors/building/review-criteria.md),
[plugin submission](https://claude.com/docs/plugins/submit.md),
[plugin checklist](https://claude.com/docs/plugins/pre-submission-checklist.md).
How the server meets them: [design/naru-mcp.md](design/naru-mcp.md).

## Before submitting

- [x] **Privacy policy covers MCP.** `/privacy` lists MCP connections in
      sections 1, 3 and 4, effective 2026-10-30, a week after it was posted
      as its section 12 promises. See [Privacy policy additions](#privacy-policy-additions).
- [ ] **Reviewer account.** A production account comped the supporter plan
      (`/admin/users/<login>`), with a few pages, a stylesheet, an image and a
      `_naru/collections.json`, so every tool has something to work on.
- [ ] **Tested in Claude.** Add `https://naru.pub/mcp` as a
      [custom connector](https://claude.com/docs/connectors/building/testing.md)
      in Claude, sign in, and
      call all six tools from a conversation; the portal's Test & launch step
      asks you to confirm it. Also load the plugin in Claude Code with
      `claude --plugin-dir ~/Git/naru-claude-plugin` and run `/mcp`.

## 1. Connector (Submit new → MCP connector)

### Connection

- Server URL: `https://naru.pub/mcp`
- Users connect to: one URL for everyone (Universal URL)

### Tools

Synced from the server; all six have a title and an annotation:

| Tool          | Annotation  |
| ------------- | ----------- |
| `get_site`    | read-only   |
| `list_files`  | read-only   |
| `read_file`   | read-only   |
| `write_file`  | destructive |
| `move_file`   | destructive |
| `delete_file` | destructive |

### Listing

- Name: `Naru`
- One-liner (≤ 200): `Read, edit and publish the pages and files of your Naru personal website (naru.pub).`
- Description (≤ 2,000):

  > Naru (naru.pub) hosts personal websites: a site at <name>.naru.pub or on
  > your own domain, served exactly as you upload it. The Naru connector lets
  > Claude work on your site's files directly. Claude can show you what's on
  > your site, read any page, write new pages or rewrite existing ones, add
  > images and stylesheets, move and rename files, and delete what you no
  > longer need. Every change is published the moment it's made, at the
  > same address visitors use.
  >
  > The connector reaches one site, the one belonging to the Naru account you
  > sign in with, and only its files: not your account settings, billing,
  > domains or site database. When you connect, you choose whether Claude may
  > only read your site or also change it. You can see every connected app
  > and disconnect it at any time on naru.pub/account.
  >
  > Use it to start a homepage from nothing, restyle the one you have, add a
  > page for a new project, or fix what's broken. Pages can also save data,
  > such as a guestbook or comments, with the Naru Data SDK.
  >
  > Requires a Naru account on the supporter plan.

- Categories: pick the closest of what the portal offers, such as
  Productivity, Design or Developer tools.
- Documentation URL: `https://naru.pub/docs/mcp`
- Privacy policy URL: `https://naru.pub/privacy`
- Support contact: `hello@naru.pub`
- Icon: `control-plane/public/logo.png` (270 × 270 PNG)
- Slug: `naru` (permanent once published)

### Use cases

- Primary use cases: create or restyle a personal homepage; add and edit
  pages; upload images; reorganize files; add a guestbook or comments with the
  Naru Data SDK.
- What users need: a Naru account (free sign-up at naru.pub) on the supporter
  plan (₩1,000 a month, or a free trial when one is open).
- Reads and writes data.

### Company

- Company: 화양전자 (Naru), `https://naru.pub`
- Primary contact: `hello@naru.pub`

### Authentication

- Authentication requirement: Always required
- Method: OAuth sign-in, with Claude's own client: the server advertises
  Client ID Metadata Documents and dynamic registration, so leave the
  Anthropic-held client credentials empty.
- Callback URLs: nothing to register. `https://claude.ai/api/mcp/auth_callback`
  and Claude Code's loopback redirects come from Claude's metadata documents.

### Data handling

- The underlying API is Naru's own.
- No personal health data, no sponsored content.

### Test & launch

Fill in the account once it exists; the credentials go only in the portal.

> 1. In Claude, add the connector and select Connect. naru.pub opens.
> 2. Sign in with the test account below. The page is in Korean: 아이디 is the
>    username field and 비밀번호 the password.
> 3. On the MCP 연결 page, leave both permissions ticked and select 연결
>    (Connect). Claude is now connected to the account's site,
>    https://<login>.naru.pub.
> 4. Try: "What's on my Naru site?" (get_site, list_files), "Show me
>    index.html" (read_file), "Add a page about.html linked from the home
>    page" (write_file), "Rename about.html to me.html" (move_file), "Delete
>    me.html" (delete_file). Changes appear at the site's address at once.
> 5. naru.pub/account lists the connection under MCP 연결, where 연결 끊기
>    (Disconnect) ends it.
>
> Username: `<login>` · Password: `<password>`

### Compliance

Read and accept the seven acknowledgments.

## 2. Plugin (Submit new → Plugin bundle)

### Source

- Repository: `naru-pub/claude-plugin`
- Plugin path: empty (the plugin is at the root)
- Branch or tag: empty (follows `main`)

Select **Validate**. `claude plugin validate .` already passes; the portal runs
more checks. The listing details come from `plugin.json` and the README.

### Data handling

- Reads or stores personal data: the plugin itself stores nothing. Through
  its declared connector, it reads and writes the files of the user's own
  Naru site.
- Sends data to services other than its declared connectors: no.
- Keeps data: no.
- Intended for people under 18: answer from Naru's own terms.

### Compliance

Check the contact email (`hello@naru.pub`) and select the four
acknowledgments.

### Review and submit

- How new versions reach the directory: GitHub push webhook (needs admin on
  naru-pub/claude-plugin), then **Set up push updates**.
- Raise `version` in `plugin.json` with every release.
- Keep `skills/naru-site/references/data-sdk.md` in step with the Data SDK's
  stable version.

## Privacy policy additions

Added to `control-plane/src/app/(main)/privacy/page.tsx` on 2026-10-23,
effective 2026-10-30:

**1. 수집하는 개인정보**, a new row:

| 구분               | 항목                                                                                                                     | 목적                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| MCP 연결 (사용 시) | 연결한 앱의 이름과 앱 정보 주소·돌아갈 주소, 허용한 권한, 연결한 시각과 마지막으로 쓴 시각, 접근 토큰과 갱신 토큰의 해시 | 이용자가 연결한 앱이 사이트 파일을 읽고 고칠 수 있게 하고, 연결 목록을 보여주고 끊을 수 있게 함 |

**3. 보유 기간과 파기**, a new item:

> MCP 연결 정보는 이용자가 계정 화면에서 연결을 끊거나 계정을 삭제하면
> 지체 없이 파기합니다. 연결에 쓰이지 않은 앱 등록 정보는 하루 뒤
> 삭제합니다.

**4. 제3자 제공**, a new paragraph:

> 이용자가 MCP로 연결한 앱(예: Claude)에는 이용자가 허용한 범위에서 사이트
> 정보와 파일이 전달됩니다. 이는 이용자의 요청에 따른 전달이며, 그 앱이
> 받은 정보는 그 앱 제공자의 개인정보 처리방침에 따라 처리됩니다. 나루는
> 이용자와 그 앱 사이의 대화 내용을 받지 않습니다.
