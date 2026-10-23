# Board templates kept in the repository

Templates live on the board (`/board`) as posts, published from a folder of the
author's own site. The sources here are the ones Naru itself publishes, so they
can be reviewed and changed like code. See [board.md](../board.md) for how
templates work.

To publish or update one:

1. Upload the folder to the operator's site, keeping its layout (for example
   `ai-starter/index.html`, `ai-starter/style.css`). Upload
   `_naru/collections.json` to the site root's `_naru/` folder, merging it with
   any declaration already there. Naru creates the collections it names.
2. On `/board/new`, set 종류 to 템플릿, choose the folder's files and tick the
   collections below. Collections travel with the template as settings only;
   `_naru/` is private and never part of a template.
3. For a new version, use 새 버전 올리기 on the existing post's edit page instead of a new post.

## ai-starter

The template `/docs/ai` and `/llms.txt` point people to: a guestbook that shows
reading, adding, paging, error codes and the owner's sign-in in one file, small
enough to paste into an AI chat and ask for changes.

- Slug: `ai-starter`
- License: CC0 1.0
- Collections: `guestbook` (read: world, write: create)
- Title: AI 스타터: 방명록
- Body:

  > AI에게 고쳐 달라고 하기 좋은, 데이터베이스를 쓰는 가장 작은 사이트입니다.
  > 방명록 하나로 글 읽기, 남기기, 더 보기, 주인 로그인과 지우기를 모두 보여
  > 줍니다.
  >
  > 적용한 뒤 https://naru.pub/docs/ai 의 안내문을 AI에게 붙여 넣고,
  > `index.html`을 보여 주며 원하는 사이트로 바꿔 달라고 하세요. 투표, 신청서,
  > 한 줄 일기, 링크 모음처럼 방문자가 무언가를 남기는 사이트라면 대부분 여기서
  > 시작할 수 있습니다.
