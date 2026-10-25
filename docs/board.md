# Board (게시판)

A message board with threaded replies at `/board`, where people share their
sites and templates. A template is a snapshot of a folder from someone's site
that anyone can apply to their own site in one step. The home page (`/`) has
a board card with three pills: 템플릿 / 사이트 자랑 (selected to start),
questions, and chat. Each shows its six newest posts, with templates and
showcased sites combined as pictures, and questions and chat as a list.
Below them come the ads, the usage notice, and 최근 업데이트된, which shows
the 24 most recently updated sites. `/sites` lists all of them, 48 per page.

Every board row is keyed by a UUIDv7 (`uuid_v7()`), so `/board/<id>` and reply
addresses can't be guessed or walked in order, while ids still sort by creation
time — reply threads order by their id path. Posts made before migration
`1790824144110` keep the random v4 ids they were published with. Template files
and previews live under `_templates/<template id>/`; the template that existed
before that migration was copied once from its old number's prefix.

Code: `control-plane/src/lib/board/` (logic), `src/app/(main)/board/` (pages),
`src/app/(main)/api/board/` (JSON routes). Schema: migration
`1790738983442_add_board`.

## Behaviour

- **Four kinds of post**: `site` (사이트 자랑), `template`, `question`, `chat`
  (잡담). A `site` post shows the author's current site screenshot; the
  screenshot run renders a site with a live `site` post even when it isn't
  discoverable. A
  `template` post carries files.
- **Plain text.** Posts and replies are never parsed as HTML or Markdown. A
  blank line starts a new paragraph, and web addresses become links
  (`BoardText`).
- **Writing needs a verified email.** Reading doesn't, and neither does
  applying a template, since that only writes to your own site.
- **Replies nest five levels deep** (`depth` 0–4). A reply to a reply at the
  last level is attached as that reply's sibling, but the person being
  answered is still notified.
- **Deletes are soft.** A deleted reply that still has live replies under it
  stays in the tree as "[삭제된 답글]". Otherwise it disappears.
- **Moderation**: authors edit and delete their own posts and replies. Admins
  (`PAYMENT_OPERATOR_USERS`, the same people who run `/admin`) can delete
  anyone's. Nobody else can.
- **Hourly limits** per user: 10 posts, 60 replies, 20 template applications.
  They are counted from the rows' `created_at`, so no counter table is needed.
- **Notifications**: a new reply notifies the post's author and the author of
  the reply it answers, at most once each, and never the person writing it.
  Opening the thread marks them read. They are listed at `/board/notifications`,
  with new versions of the templates someone installed (below).
- **Fediverse**: publishing a template post sends a Create(Note) to the
  author's followers, linking to the post, and adds it to their outbox
  (`dispatchTemplatePost`). Deleting the post sends Delete(Tombstone) and
  removes the note from the outbox. Replies from the fediverse are not
  received.

## Templates

- **A template is the files the author checks.** The share form shows the
  whole site with nothing checked, and folders start collapsed. The
  template's root is the deepest folder holding every checked file, so
  checking `hello-world/index.html` shares `index.html` from the root
  `hello-world/`. Its name (for example `alice/hello-world`), which is also
  the default folder when someone applies it, is filled in from that folder.
  `/.backup/` is hidden and refused. Only file types the upload route accepts
  are allowed. The limits are 200 files and 20 MiB, so publishing and
  applying each fit in one request of R2 copies.
- **Publishing takes a snapshot.** The files are copied to
  `_templates/<template_id>/v<version>/` in the site bucket. Login names match
  `^[a-z0-9]+(-[a-z0-9]+)*$`, so no one's site can collide with that prefix.
  Later edits to the author's site don't change the template. "새 버전
  올리기" (publish a new version) on the edit page takes another snapshot,
  starting with the previous version's files checked.
- **Licenses**: the author picks one of `LICENSES` (CC0, permissive or
  copyleft, AGPL among them) and consents to it explicitly. Authors dedicate
  or license their own contributions and retain applicable third-party
  notices. A template keeps its license across versions.
- **Collections**: an author can attach some of their own site-data
  collections. Only each collection's name and permissions travel with the
  template, never its documents. Applying creates them empty, but only for
  someone with the database feature. A name the person already uses is left
  alone.
- **Where versions come from** (`board_templates.source`): `site`, a
  snapshot of the author's checked files ("새 버전 올리기"), or `github`, a
  GitHub Actions workflow on the template's repository, ref and folder
  (`github_path`, the action's `dir`; `lib/board/template-uploads.ts`). A
  workflow publishes through the deploy endpoints naming the template's
  owner and its folder (`templateOwner`, `folder`; the action's
  `template-owner:`) or the template's ID (`template`), in place of `site`.
  An owner has one template per repository, ref and folder, so a workflow
  names its owner and finds its template without an ID, and may run before
  the template's post exists: plan then answers `skipped` and the action
  succeeds. Naming the owner keeps another account that names the same
  repository from taking its runs. Plan answers upload URLs
  for the files whose sha256 the previous version lacked, finalize checks
  them, refuses site code that does not parse (`_naru/**/*.js`,
  `routes.json`), and publishes the version with the commit's sha and
  message; an upload with exactly the latest version's files makes none,
  so several templates can share one repository and branch, each published
  from its own folder (the action's `dir`) on every push. A `github`
  template starts with no versions. Its uploads are
  staged in `board_template_uploads` and expire with the deploys' cleanup.
  Limits: 500 files and 50 MiB (a built site with its own code), against
  200 and 20 MiB for snapshots.
- **Site code**: a version whose files include `_naru/` (`site_code`)
  installs at the site's root only (a site has one `_naru/`), needs the
  database feature, and is refused while another template's site code is
  installed there. Applying it publishes the site's code (the purge after
  copying does); if Naru refuses it, the files go back and nothing is
  recorded.
- **Applying** is two calls:
  1. `apply/plan` reports which files would be created or overwritten, and
     writes nothing.
  2. `apply` works the plan out again on the server. It first copies each
     file it will overwrite into `.backup/<Seoul time>/` (with backup off,
     into a folder of its own that goes once the template is in). Then it
     copies the template's files in, creates the collections, and records the
     application. It is all or nothing: if a file cannot be copied, or Naru
     refuses the site's code, every overwritten file goes back, the files it
     created go, and nothing is recorded. A page that asks for
     `application/x-ndjson` gets its progress as it goes (backing up,
     copying, the site's code, collections), then a `done` line with the
     result; the dialog shows it as a bar.
- **One at a time per site.** Applying and updating take a PostgreSQL
  session advisory lock on the site (`site-lock.ts`) for the whole
  operation, so a second one at once (a double click, another tab, an
  automatic update) is refused with 409 rather than interleaved; the
  hourly limit is counted inside it. R2 copies run 16 at a time
  (`concurrency.ts`), and a failure waits for the copies in flight before
  anything is put back.
- **`apply_count`** counts distinct people, not applications.
- **Previews** show the snapshot, never the author's live site. Publishing
  sends a Postgres `NOTIFY` on `board_template_published`. The cron process,
  which runs in the jobs image where Chromium is, listens for it and runs
  `update-screenshots --templates` straight away. That run serves each
  version's stored files from a loopback web server inside the container,
  screenshots it, and uploads it to the site bucket as
  `_templates/<id>/v<n>.png`, beside the version's files. (Site screenshots
  are in the same bucket, as `_screenshots/<login name>.png`.) The 15-minute
  screenshot run also picks up anything missed. A version that still has no
  preview after a day is no longer tried. `update-screenshots --templates --force` renders every live
  version again.
- **Own preview images**: a template whose files show nothing on their own
  (an app that needs its site's data or a sign-in, which the loopback server
  can't give it) can show an image instead. The author picks one when posting
  (the form uploads it after the post exists) or on the edit page at any
  time, through `PUT /api/board/templates/<id>/preview` with the image as the
  body (`DELETE` goes back to the screenshots); a workflow names one with the
  action's `preview` input. PNG, JPEG or WebP up to 5 MB, typed by its bytes,
  shown at 4:3 from the top. It is one image for the template, at
  `_templates/<id>/preview`, recorded in `board_templates.preview_*`, and
  stands in for every version's screenshot until removed. Screenshots are
  still rendered, so removing it shows the latest one.
- **Deletion**: deleting a template post removes its R2 files and previews.
  The database rows stay, so the record of who applied it is kept. Deleting an
  account also removes that user's `_templates/` objects and their site
  screenshot.

- **Installs and updates** (`lib/board/updates.ts`): applying records an
  install (`board_template_installs`: the folder, the version, every file it
  wrote with its ETag then, and `updates`: `notify`, `auto` or `never`).
  `/templates` lists a person's installs and offers newer versions. An update
  works out each file: the template's own files (ETag unchanged since
  install) are replaced or deleted, files the owner changed are backed up and
  replaced (or kept, where the new version drops them), the owner's own files
  at a path the new version uses are backed up and replaced, unchanged ones
  are left. Everything it replaces or deletes goes to `/.backup/<stamp>/`
  first; if Naru refuses the new site code, it all goes back and the install
  stays on its version. Publishing a version queues an update
  (`template-update-v1`, the maintenance worker) for each `auto` install,
  which skips a version that adds migrations, and tells each person with a
  `notify` install (알려 주기) through a board notification
  (`board_notifications.reason = 'template_version'`, migration
  `1792911506464`): one per person and version, replacing their unread one of
  an earlier version, never the author's own. `/board/notifications` lists
  them beside replies, linking to `/templates`, and opening `/templates`
  reads them. The 템플릿 link in the navigation counts the installs with a
  newer version waiting (`installCounts`). A `never` install (받지 않기) is
  never told and `/templates` does not offer it new versions until its
  setting changes. Disconnecting an install
  forgets it; its files stay. Applications from before installs existed
  (migration `1792850254347`) have none and are not updated.

## Routes

| page                                | what                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `/board`                            | list; `?kind=`, `?sort=activity\|new\|applied`, `?page=` |
| `/board/new`                        | compose; `?kind=`                                        |
| `/board/[postId]`                   | post, template panel and apply dialog, reply tree        |
| `/board/[postId]/edit`              | edit; publish a new template version                     |
| `/board/[postId]/replies/[replyId]` | a reply and everything under it (permalink)              |
| `/board/notifications`              | my reply and template version notifications              |

Every API route takes JSON only, including DELETE, and refuses cross-origin
requests (`readJson`):

- `POST /api/board/posts`
- `PATCH`/`DELETE /api/board/posts/[id]`
- `POST /api/board/posts/[id]/replies`, `PUT`/`DELETE …/like`, `POST …/solve`
- `PATCH`/`DELETE /api/board/replies/[id]`, `PUT`/`DELETE …/like`
- `POST /api/board/templates/[id]/versions`
- `POST /api/board/template-versions/[id]/apply/plan`, `POST …/apply`
- `PUT /api/board/templates/[id]/source`
- `GET /api/board/installs`, `PATCH`/`DELETE /api/board/installs/[id]`,
  `POST …/update/plan`, `POST …/update`
- `POST /api/board/notifications/read`

## Tests

`pnpm test:board` runs `src/lib/board/__tests__` against a throwaway
PostgreSQL cluster migrated to the latest schema. R2 is replaced by an
in-memory bucket in these tests.

## Not built yet

- A live preview of the exact snapshot. It would need a separate preview
  address served by the edge Worker, so a template's HTML never runs on the
  control plane's origin.
- Per-thread subscriptions, reports, and a moderator list separate from the
  payment operators.
- Receiving replies from the fediverse.
