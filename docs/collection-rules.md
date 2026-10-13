# Native collection rules for boards and secret posts

An owner enables a rules module in the database panel's collection permissions.
The field contains a module name, for example `community-board`, loaded from the
site's `_naru/rules/community-board.js`. The equivalent owner control-panel PATCH
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

- `scope(ctx, { collection, operation, id, filter })`: `operation` is `get` or
  `list`. Return `true`, `false`, or a predicate built from `all`, `any`, `eq`,
  and `ne`. Comparisons are `[field, scalar]`; fields name top-level JSON data
  fields or `{ metadata: "id" | "createdBy" }`. Values are string, finite number,
  boolean or null. Equality matches JSON types exactly; explicit null does not
  match a missing field. Inequality includes missing fields.
- `canWrite(ctx, { collection, operation, before, after })`: return exactly
  `true` to allow `create`, `update` or `delete`. `before`/`after` are documents
  with canonical id/data/createdBy, or null. Before is read from storage, and the
  owner/member author cannot be forged through the request. Updates and deletes
  check the supplied revision before the rule executes, inside the same SQLite
  transaction as the write.

Rules use the function sandbox's read methods (`await ctx.get(...)`,
`await ctx.list(...)`) and `ctx.member` (null for visitors). Writes are forbidden, including at module load.
A missing, invalid, mutating or over-budget module fails closed. Rule file
refresh uses the existing 10-second source cache; publish stricter rules before
opening permissions and allow that cache window to expire. Rules-bearing reads
are never shared-cacheable. Previously cached public data can remain visible
for its existing ten-second TTL when rules are first enabled.

The scope predicate is intersected with the caller's filters in SQL before
sorting, pagination and count. Hidden secrets cannot create short pages, inflate
totals or contribute cursor values. Cursors bind to the scope fingerprint; if a
role or board change changes that scope, start pagination again. Hidden get
requests return NOT_FOUND. A false list scope returns an empty list and zero
count. A denied write returns ACCESS_DENIED. Predicates are limited to 100 nodes
and ten nesting levels; sandbox CPU, memory and read budgets remain bounded.

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
