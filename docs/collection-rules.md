# Native collection rules for boards and secret posts

An owner enables a rules module in the database panel's collection permissions.
The field contains a module name, for example `community-board`, loaded from the
site's `_naru/rules/community-board.js` (or `.mjs`). Rules are published with the
site's functions, in the same immutable revision: a rule may import
`_naru/modules/` (and other rules) with relative paths, and changes to it take
effect, all at once, when the site's `_naru` files are next published. Functions
and shared modules cannot import a rule. The equivalent owner control-panel PATCH
body is `{ read: "member", write: "member", rules: "community-board" }`.
`rules: null` disables rules; omitting it preserves the current setting.
Collection-scoped website tokens cannot change this setting.

Existing collection permissions remain the first gate. For non-owner document
requests, configured rules add SQL read restrictions and transactional write
checks. With a rule configured, the rule owns authorship/moderator checks instead
of the built-in author-only write check. Never enable a permissive write hook on
member collections. Owners bypass rules; owner-authorized site functions and
batches retain their existing authority and must still check business rules.
No PostgreSQL migration or change to frozen SDK 1.0.0 is required.

A module exports two functions, which may be `async`:

- `readable(ctx, { collection, operation, id, filter, where })`: which
  documents this reader may read, as a condition, not a yes or no for one
  document: Naru adds it to the query, so pages and counts hold only what the
  reader sees. `operation` is
  `get` or `list`; `where` is the caller's own predicate, or null. Return
  `true`, `false`, or a predicate built from `all` and `any` of comparisons:
  `eq`, `ne`, `gt`, `gte`, `lt` and `lte` take `[field, value]`, `in` takes
  `[field, [1 to 100 values]]`, `has` takes `[field, value]` (an array field
  holding it) and `contains` takes `[field, text]` (a string field with it). Fields name top-level JSON data fields or
  `{ metadata: "id" | "createdBy" | "createdAt" | "updatedAt" }`. Values are
  string, finite number, boolean or null; ranges compare strings or numbers,
  and the two times a UTC ISO string. Comparisons match JSON types
  exactly; explicit null does not match a missing field. Inequality includes
  missing fields. This is the same language as a list's `where`.
- `canWrite(ctx, { collection, operation, before, after, secret })`: return
  exactly `true` to allow `create`, `update` or `delete`. `before`/`after` are
  documents with canonical id/data/createdBy, or null. Before is read from
  storage, and the owner/member author cannot be forged through the request.
  Updates and deletes check the supplied revision before the rule executes,
  inside the same SQLite transaction as the write. `secret` (1.1.0) is `true`
  when the request gave the secret the document was added with, `false` when
  it gave another, and `null` otherwise: a guest's password, checked by Naru.
- `present(ctx, { collection, document })` (optional, 1.1.0): returns the data
  a non-owner reads of `document`, for example without its private fields. It
  applies to gets, lists, batch reads and the result of a write. A module that
  exports it also exports `queryable`, the fields non-owners may filter,
  `where` and sort on (`export const queryable = ["board", "tags"]`); other
  fields are refused with `INVALID_REQUEST`, so a hidden value cannot be found
  by asking which documents match it. Rows still come from `readable`.

Rules use the function sandbox's read methods (`await ctx.get(...)`,
`await ctx.list(...)`) and `ctx.member` (null for visitors). Writes and live
messages are forbidden, including at module load. A missing, invalid, mutating
or over-budget module fails closed. Publish stricter rules before opening
permissions: a rule applies from the revision that contains it. Rules-bearing
reads are never shared-cacheable. Previously cached public data can remain visible
for its existing ten-second TTL when rules are first enabled.

The `readable` predicate is intersected with the caller's filters in SQL before
sorting, pagination and count. Hidden secrets cannot create short pages, inflate
totals or contribute cursor values. Cursors bind to the caller's filter,
`where` and sort, not to the predicate: it is applied again on every page, so
one that depends on data (a reader's own items, say) can change mid-paging
without invalidating the cursor; later pages follow the new predicate. Hidden get
requests return NOT_FOUND. A `false` from `readable` makes a list empty with a zero
count. A denied write returns ACCESS_DENIED. Predicates are limited to 100 nodes
and ten nesting levels; sandbox CPU, memory and read budgets remain bounded.

Either hook may call `ctx.fail(code, message, details)`, as a function does:
the request fails with that code, and the message is the site's own, shown to
the visitor as is (`site: true`). Use it where `false` would leave a member
guessing, a members-only board, say. Naru's own refusals name the rule for the
owner, in the English account SDK 1.1.0 keeps as `error.cause.message`:

- a write `canWrite` did not allow: `Collection rule _naru/rules/board.js
refused this update on posts: canWrite returned undefined. …` (a missing
  `return true` is the usual cause), or `no canWrite function`;
- a `readable` result that is not a predicate: `Collection rule … readable() for
posts returned an invalid predicate: …`;
- a rule that throws or runs past a limit: `Collection rule … failed in
readable() for posts: …`, also for a module that exports no `readable`;
- a rule the site's published files do not have: `Collection posts uses
_naru/rules/board.js, which the site's published files do not have; …`.

[The board example](examples/community-board-rules.js) uses neo-avocado's board,
member-role, log and comment shapes. Publish it as the rules module, then enable
it on `neo_avocado_logs` and `neo_avocado_comments`, with member read/write access.
It enforces board list/read/write/comment levels, moderator access, immutable
ownership/board/parent links, and secret visibility for authors/moderators only.
It requires explicit board IDs, including `default`; legacy missing boards need
backfilling before native reads. Secret posts are hidden entirely from other
members; this version does not return locked previews or redact individual fields.
Comments require an accessible parent and an explicit `logId` list filter.

A page then uses ordinary member collection reads:

```js
const posts = member.collection("neo_avocado_logs");
const page = await posts.list({ filter: { board: "default" }, size: 10 });
const comments = await member.collection("neo_avocado_comments").list({
  filter: { logId: page.documents[0].id },
});
```

For writes, supply the complete validated document shape. The example deliberately
denies native log deletion: keep cascading cleanup in a site function. Other
private/economy collections remain behind their existing checked functions.
There is no live neo-avocado permission/data cutover in this change. Deploy the
new Worker and control plane before using the setting, publish rules before
opening collections, and verify native access with multiple test members first.
