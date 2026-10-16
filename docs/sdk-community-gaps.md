# What Naru SDK 1.1.0 is missing for AvocadoEdition-class sites

## Current status (2026-10-13)

neo-avocado is an SDK test case, not a feature-parity target. The assessment below
is historical; these gaps have since been addressed:

- Native site membership gates collection, function and media operations.
- Collection rules handle board permissions and secret posts; neo-avocado's
  post/comment reads now use native collections. Rules run from the function
  revision and may import `_naru/modules/`, so they share code with functions.
- Modules declare read-only exports (`export const readOnly = [...]`), which
  run without writes on a separate budget; there is one `call()`. The owner
  calls functions too (`admin.call`, `ctx.owner`).
- SDK 1.1.0 uploads return IDs and media deletion supports explicit owner grants
  and an optional uploader guard. Naru records which documents name every
  upload, and the media library marks those none does; functions do not
  delete uploads.
- `ctx.fail(code, message, details)` aborts functions transactionally and reaches
  callers as a `NaruError` whose `details` carries the app's own reason.
- `ctx.getMany` batches up to 100 lookups; `ctx.count` counts without reading
  bodies; `ctx.set`/`ctx.delete` take revision conditions. Browsers have
  `getMany` too.
- Richer filters (#6): `where` predicates (`any`, `ne`, `in`, ranges,
  `createdBy`) on client and function lists and counts.
- Unique constraints (#7): up to three unique fields per collection. Counters and
  sequences remain function work.
- Realtime (#8): live connections hear `ctx.notify`/`ctx.broadcast` from
  functions, replacing polling. Plain writes do not notify.
- Functions have `URL` and `URLSearchParams`, and modules may be `.mjs`.

- Guest function calls (#3): modules open exports to visitors
  (`export const visitors`), with document secrets (`ctx.secretMatches`) for guest edit and delete.

Still open: background and scheduled jobs (#4, #9, deliberately not planned),
export/import (#10), storage quotas (#2) and a local emulator. Revisit quotas
with actual usage before raising ceilings. Keep cascading deletes and economy
operations in transactional functions. UI parity is outside this SDK refinement
work.

See [media deletion](media-deletion.md), [collection rules](collection-rules.md)
and [site functions](sdk-v1-api.md#site-functions-110).

## Original assessment

_Historical snapshot, 2026-10-12. Based on neo-avocado as of `dc814e4`, the AvocadoEdition reference
and naru-pub `main` (`b54952a0`) plus the unmerged
`codex/sdk-110-readonly-functions` branch. Paths such as `app.js`,
`_naru/functions/neo-avocado.js` and `admin-*.js` are in the neo-avocado
repository; `bbs/`, `adm/`, `inventory/` and `mypage/` paths are in
AvocadoEdition._

## Constraints

- **The audience is a casual developer.** Not very technical, dabbles in PHP.
  They can write "check, then save" request handlers and HTML/JS pages. They
  should not need to understand optimistic concurrency, cursor pagination,
  idempotent chunking or sandbox runtimes in order to build a community site.
- **neo-avocado is the yardstick, not the goal.** It ports AvocadoEdition (a
  GnuBoard 5–based Korean role-play community CMS) to Naru. It doesn't have to
  reproduce every AvocadoEdition feature. Its job is to show what the SDK lacks,
  and whether a casual user could build something like it.
- **The SDK can change.** 1.1.0 is still mutable, and we may extend it or
  change it. 1.0.0 is frozen, and the `/api/data/v1` wire routes are a frozen
  compatibility surface. Additions should keep the SDK and server surface
  minimal.
- **Naru replaces the hosting layer.** PHP hosting, passwords, email
  verification and SQL maintenance are the platform's job. They are not app
  features to reimplement.

## Verdict

A PHP dabbler **cannot** build neo-avocado at its current level on SDK 1.1.0.
They could build the simple version: everyone can post, authors edit their own
documents, and money/shop logic lives in site functions. Once any of these
appears, the SDK forces them to write their own authorization server in
QuickJS:

- application approval
- bans
- board levels
- secret posts
- moderators
- cascading deletes

They would also need a client shim that imitates the SDK, and chunked recovery
tooling. That is professional-level work.

The port is _safer_ than the original. AvocadoEdition:

- lets members self-approve characters (`ch_state` posted by the client in
  `character_form_update.php`);
- doesn't check stat allocation against available points;
- lets members sell items they don't own (`inventory/sell_item.php`);
- races shop stock checks (`COUNT(*)` then insert).

Naru's transactional functions and server randomness get these right by
default. Keep that property while closing the gaps below.

## The central gap: permissions don't know about community membership

Collection permissions are only `admin | member | world` (plus `create` for
writes), and "authors edit their own documents". AvocadoEdition's rules depend
on community state:

- approved, pending or banned members
- member levels 1–10, gated per board for list, read, write and comment
- moderators
- secret posts and owner-only profile fields

None of this can be expressed, so neo-avocado moved everything behind a
gateway:

- **Every collection is admin-read and admin-write.** All member access goes
  through a generic `communityData` site function
  (`_naru/functions/neo-avocado.js:153–380`). It carries a collection
  whitelist, per-kind read limits, board ACLs and secret-post redaction.
- **A client shim imitates the SDK collection API** on top of the gateway
  (`app.js:175–221`).
- **Each of the 25 exported functions starts with `requireMember(ctx)`.** About
  40 ownership comparisons and about 76 hand-written validations follow.
- **Reads used up the mutation budget**, because they went through
  `member.call` (30/min per member). That required a new SDK API,
  `member.read` (120/min, writes forbidden). It exists only on the unmerged
  `codex/sdk-110-readonly-functions` branch, but neo-avocado already depends
  on it.
- **One mistake breaks the gate.** `docs/membership-cutover.md` warns that a
  single collection left at member or world permission lets native SDK
  requests bypass it.

About 40% of the server module is authorization and limit plumbing rather than
features. A casual user won't get this right.

**Proposal.** First-class site membership, enforced by Naru itself on
collections, functions **and media upload**:

- **Status:** approved, pending or banned.
- **Role:** for example member or moderator.
- **Level:** 1–10.
- **Admission mode:** open, approval or closed.

On top of that, add per-collection rule hooks. For example,
`_naru/rules/<collection>.js` would export `canRead(ctx, doc)` and
`canWrite(ctx, before, after)`, which run in the existing function sandbox.
Plain `collection().list()` and `add()` would then work again, and the
mental model is the one a PHP dabbler already has: check, then save. This
would:

- delete the gateway, the shim and the read/call budget split;
- make most `requireMember` and ownership boilerplate unnecessary;
- close the hole where a banned member's Naru token can still upload media.

## Other gaps, ranked

Ranked by impact on the port × how much each simplifies life for a casual user.

| #   | Gap                                                                                                              | What the port does today                                                                                                                                   | Needed for                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 2   | **Storage quota of 10,000 documents and 10 MiB per site**                                                        | Nothing yet; it is a hard ceiling                                                                                                                          | Every comment, message, history row and inventory item is one document                     |
| 3   | **Guests can't call functions** (`call` or `read`)                                                               | Public/guest boards are pending                                                                                                                            | Guest browsing and posting on the log board                                                |
| 4   | **25 writes per function call; no background jobs or cascade delete**                                            | `deleted` markers, resumable client loops, owner recovery queue (`admin-cleanup.js`), chunked title grants (`admin-titles.js`), 20-recipient/material caps | Deleting posts and characters, bulk grants, in-post game actions                           |
| 5   | **Media: `upload()` returns no id, and there is no `delete()`**                                                  | Orphaned files fill the 250 MiB quota; `docs/media-api-proposal.md` is unapproved                                                                          | Deleting posts (`bbs/delete.php:84`) and characters (`character_delete.php:14–18`)         |
| 6   | **Queries:** filters are AND-only; no `in`/OR, `ne` or `createdBy` filter; no `count` in functions; no `getMany` | Nicknames and partners fetched one at a time, couples filtered on the client, short pages after post-filtering, no comment counts                          | Lists, couples, comment counts, "my posts"                                                 |
| 7   | **No atomic counters, sequences or unique constraints**                                                          | Stock and purchase limits are hand-kept maps; nicknames aren't unique                                                                                      | Log numbers (`wr_num`, `@123` links), view/comment counts, unique nicknames, one vote each |
| 8   | **No realtime or notifications**                                                                                 | Polls `messageStatus` every 5 s, costing 12 of the 120 reads/min                                                                                           | Board, mention and message alerts (the original polls every 3 s and 5 s)                   |
| 9   | **No site time zone, "today" helper or scheduled jobs**                                                          | Hand-written KST offset (`neo-avocado.js:615–616`)                                                                                                         | Daily rewards, shop hours, banner/popup windows                                            |
| 10  | **No document export, import or backup**                                                                         | The AvocadoEdition data import is blocked                                                                                                                  | Migrating existing communities; operator safety                                            |

Smaller ergonomic items:

- **Typed errors from functions.** Functions return `{ ok: false, reason }`
  and the client remaps it to SDK-like codes (`app.js:185–208`). Something
  like `ctx.fail("conflict")` surfacing as a `NaruError` would remove that.
- **Collection schemas and validators.** These would replace the hand-written
  `text()`, `amount()` and `imageUrl()` checks. QuickJS has no `URL` global,
  hence a regex.
- **Conditional writes and read preconditions inside functions.** Today an
  admin batch rewrites a document unchanged just to lock its revision
  (`admin-titles.js`).
- **A local emulator.** Local pages read and write production data, and
  functions can only be tested by deploying them.
- **Error-message language.** Server error messages are English, while the
  guides are Korean.

## What neo-avocado still lacks

| Feature                                                 | Blocker                                               |
| ------------------------------------------------------- | ----------------------------------------------------- |
| Public/guest boards                                     | SDK (#3)                                              |
| Media deletion; upload authority for banned members     | SDK (#5, #1)                                          |
| Board, comment and mention notifications                | SDK (#8); possible with polling at a cost             |
| Log numbers and `@N` links, comment counts              | SDK (#6, #7)                                          |
| Data import from AvocadoEdition                         | SDK (#10)                                             |
| Unattended cleanup recovery                             | SDK (#4)                                              |
| Owner-only/admin-only custom profile fields             | SDK (#1)                                              |
| Rich posts (editor HTML, inline images)                 | App work, plus a sanitizer; media deletion (#5) helps |
| Menus, content pages, themes (CSS variables), emoticons | App work only                                         |
| Public custom profile fields, polls                     | App work only                                         |
| Title cascade deletion, gallery review                  | App work (eased by #4)                                |

Safe to skip:

- **Quests.** The reference has admin pages (`adm/quest_*.php`) but no
  `CREATE TABLE` and no member page.
- **Platform plumbing.** Visitor statistics, IP logging, email/SMS, RSS and
  Naver syndication are out of scope.
- **Captcha.** Only needed if guest posting goes through functions.
- **The design manager's PHP-generated CSS.** Raw script/meta injection
  should not be replicated on a multi-tenant host.

## Risks

- **Supporters-only membership.** Members now need a Naru supporter plan
  (2026-10-14), so only supporters can join a community site. Communities
  whose members are not supporters will need visitor (guest) access instead.
- **1.1.0 is still mutable.** The stable `/sdk/1/` alias stays on 1.0.0; sites explicitly importing 1.1.0 follow its changes,
  and pinning `/sdk/1.0.0/` loses members and functions. Freeze 1.1.0 only
  after #1 settles.

## Suggested order

1. Membership and rule hooks (#1). This changes the shape of everything else.
2. Storage quota (#2) and guest access (#3).
3. Media id/delete (#5) and larger write budgets or background jobs (#4). The
   port has workable stopgaps for these.
4. Query, counter and notification primitives (#6–#8), driven by the next
   template or app that needs them.
