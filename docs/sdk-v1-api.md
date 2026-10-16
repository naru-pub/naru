# Naru Data SDK v1 API reference

Naru Data is a dependency-free browser ES module for JSON documents and media
owned by one Naru site. Import the versioned module and create one client:

```js
import { createNaru, NaruError } from "https://naru.pub/sdk/1/naru.js";

const naru = createNaru({ site: "alice" });
```

`site` may be omitted (or empty) on a `*.naru.pub` site. The module's matching
TypeScript declarations are at `https://naru.pub/sdk/1/naru.d.ts`.

`/sdk/1/` stays on stable 1.0.0, whose bytes are frozen. The public `/docs`
guides also describe 1.0.0. SDK 1.1.0 remains in development; its members,
functions and newer APIs require importing `/sdk/1.1.0/naru.js` explicitly.

## Start with reading

Create a `posts` collection in the control panel, enable public reading, and
save a document with a `title`. Add this to a page hosted on your Naru site:

```html
<ul id="posts"></ul>
<script type="module">
  import { createNaru } from "https://naru.pub/sdk/1/naru.js";
  const naru = createNaru();
  const page = await naru.collection("posts").list();
  for (const post of page.documents) {
    const item = document.createElement("li");
    item.textContent = post.data.title;
    document.querySelector("#posts").append(item);
  }
</script>
```

A collection groups documents. Each document has an ID and your JSON in `data`.
This example reads the first page; add pagination when you need more records.

For a guestbook, create a `guestbook` collection with public reading and
create-only visitor writing. Call the following from a submit or click handler,
not on page load. The saved result has the same shape as a read:

```js
const saved = await naru.collection("guestbook").add({
  name: "Visitor",
  message: "Hello!",
});
console.log(saved.data.message, saved.createdAt);
```

Next, learn admin sign-in to edit posts, then members for a community, then
pagination, and finally revision conditions and atomic batches. No API key or
build tool is needed.

## Visitor collections and queries

The client separates anonymous operations from administrator operations:

```ts
const posts = naru.collection<Post>("posts");
const post = await posts.get("hello", { signal });
const page = await posts.list({
  filter: { published: true, date: { gte: "2026-01-01" } },
  sort: [
    ["date", "desc"],
    [{ metadata: "createdAt" }, "desc"],
  ],
  size: 20,
  includeTotal: true,
  signal,
});
const created = await posts.add({ title: "Hello" }, { signal });
```

`naru.collection(name)` has only `get`, `list`, `count`, `pages`, and `add`. Collection policy
decides whether a particular anonymous operation is allowed. These handles always
use visitor access, even while signed in.

## Sign in to edit

An admin client
is restored for the current browser tab or obtained by redirecting for approval:

```js
let admin = await naru.auth.session();
if (!admin) {
  await naru.auth.signIn({ collections: ["posts", "categories"] });
  // The browser leaves this page. Call session() after the redirect back.
}
```

`signIn` makes no request of its own. A page can be registered in the control
panel beforehand, but it need not be: when the page is not registered yet, or
asks for collections the site does not have or its registration does not
include, Naru's consent page offers to set that up on the owner's click before
asking for approval. The site never sees that error. A registration names a
page, so it also matches the other addresses Naru serves that page at (`/` and
`/index.html`; `/about`, `/about/` and `/about/index.html`), and sign-in
returns to the address it left from.

A sign-in that comes back without completing, because the owner denied it,
took longer than ten minutes, or the code could not be exchanged, is an
ordinary signed-out visit: `session()` resolves `null`.

Collections the consent page creates start private. A site says what its
collections should be in a file, `_naru/collections.json`, so they exist
before anyone signs in and sign-in stays a sign-in:

```json
{
  "collections": {
    "posts": { "read": "world", "write": "admin", "rules": "community-board" },
    "profiles": { "read": "admin", "write": "admin", "unique": ["nick"] },
    "wallets": { "read": "admin", "write": "admin" }
  }
}
```

`read` is `admin`, `member` or `world`; `write` also takes `create`; `rules`
names a `_naru/rules/` module and `unique` up to three fields no two documents
may share. `read` and `write` are required, so the file states who can reach every
collection; an entry without them fails the whole file. `rules`, `unique`
and `indexes` may be left out. `indexes` names up to five top-level fields
reads filter on often (`"indexes": ["board", "owner"]`): a list that filters
on one with `filter` or `where` (a rule's `readable` included), newest or
oldest first, reads only its page instead of every document. Each adds a
little to every write in its collection, and an index does not help
`contains`, `in`, or sorting on another field. When the file arrives (a
template applied, a GitHub deploy, a save in the editor) Naru creates the
collections the site lacks with these settings, and applies a change to
existing collections' indexes alone at once, since an index opens nothing to
anyone. Other changes to existing collections wait for the owner, who sees
them on /database and applies them with one click. The file needs SDK 1.1.0
only for `rules`; it works with any SDK version, and sites without it are
unaffected. `pnpm naru-dev` installs it too, changes included.

The browser leaves the page during `signIn`, and a page that holds unsaved
input should put it somewhere that survives, such as `sessionStorage`, before
calling it, and restore it after the redirect back. The same applies when a
request fails with `AUTH_REQUIRED`, which is the other moment an editor asks
its owner to sign in again. Active use renews the session within platform limits; it can still expire or
be revoked. Preserve unsaved work independently of the session.

An admin collection adds replacement and deletion:

```js
const posts = admin.collection("posts");
const saved = await posts.set(
  "hello",
  { title: "Hello" },
  {
    condition: { absent: true },
    signal,
  },
);
await posts.set(
  "hello",
  { title: "Updated" },
  {
    condition: { revision: saved.revision },
  },
);
await posts.delete("hello", {
  condition: { revision: saved.revision },
});
```

`set` replaces the complete JSON value; there is no patch operation. An
unconditional `set` is last-write-wins. Deleting an absent document succeeds
unless a condition was supplied.

## Members (1.1.0)

A member is a visitor who signed in to your site with their own Naru account.
Any Naru account with a supporter plan can be a member of any site with the database; there is
nothing to register. Members are what a community site is made of: give a
collection `member` read access to keep it to members, and `member` write
access to let them post.

```js
let member = await naru.members.session();
if (!member) {
  await naru.members.signIn();
  // The browser leaves for Naru and comes back to this page, query included.
}
const board = member.collection("board");
const post = await board.add({ title: "Hello" });
post.createdBy === member.id; // true
await board.set(post.id, { title: "Edited" }); // its author may
await board.set(member.id, { nick: "bob" }); // the one ID only they may claim
```

`member.id` is the member's ID on this site, the same on every visit. It is
not their Naru account name or email, which the site never receives, and
another site sees a different ID for the same account. Keep display names in
a document the member writes under their own ID.

A member sign-in lasts across every page and tab of the site, in its
`localStorage`, until the member signs out, signs out of Naru, or leaves it
unused for seven days; it ends 30 days after signing in regardless. A
member's handle has `collection()`, `media.upload()` and `signOut()`, and
their collections add `set` and `delete` to a visitor's. What they may do
there is the collection's permissions:

| Collection access | A member may                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------- |
| read `member`     | Read it. Visitors cannot.                                                                    |
| write `member`    | `add`; `set` and `delete` documents they created; `set` the document whose ID is their `id`. |
| write `create`    | `add`, like any visitor.                                                                     |
| write `world`     | Anything, like any visitor.                                                                  |
| `admin`           | Nothing; it is the owner's.                                                                  |

`naru.collection()` stays anonymous after a member signs in. Every document a
member creates records them as `createdBy`; a replacement, by its author or the
owner, keeps it. Members upload into the site's media, a limited number of
files an hour each. They cannot batch, list or delete media, or change
collections. A member's writes are rate limited per member, and members'
requests count against the site's monthly budget like visitors'.

A sign-in that was denied, took longer than ten minutes, or could not be
completed resolves `session()` with `null`. Members need a Naru supporter
plan, unless Naru has exempted the site: an account without one is asked to support Naru on Naru's sign-in page,
and a member whose plan has ended gets `ACCESS_DENIED` until it resumes.

An owner's and a member's sign-in can share a page: each only finishes the
sign-in this tab started for it.

## Site functions (1.1.0)

Rules a member's browser must not decide, such as prices, balances, stock or
dice, run on Naru as site functions. Put a module in the site's files at
`_naru/functions/<module/path>.js` (or `.mjs`) and export functions from it:

```js
// _naru/functions/shop.js
export const readOnly = ["catalog"];

export async function buy(ctx, { item }) {
  const listing = await ctx.get("shop", item);
  if (!listing || listing.data.stock < 1)
    ctx.fail("CONFLICT", "품절입니다.", { reason: "sold_out" });
  const wallet = await ctx.get("wallets", ctx.member.id);
  if (wallet.data.balance < listing.data.price)
    ctx.fail("CONFLICT", "잔액이 부족합니다.", { reason: "not_enough" });
  await ctx.set("wallets", ctx.member.id, {
    balance: wallet.data.balance - listing.data.price,
  });
  await ctx.set(
    "shop",
    item,
    { ...listing.data, stock: listing.data.stock - 1 },
    { condition: { revision: listing.revision } },
  );
  await ctx.add("inventory", { owner: ctx.member.id, item });
  ctx.notify(ctx.member.id, { bought: item });
  return { ok: true };
}

export async function catalog(ctx) {
  return (await ctx.list("shop", { where: { gt: ["stock", 0] } })).documents;
}
```

```js
const result = await member.call("shop:buy", { item: "sword" });
const items = await member.call("shop:catalog");
```

Module paths may use subdirectories: `member.call("community/boards:list")`
loads `_naru/functions/community/boards.js` and calls its `list` export.
Each path segment must be a plain name; empty segments, traversal and
backslashes are rejected. The colon separates the export from the file path.
A module may be `.js` or `.mjs`, not both under one name.

**Who calls.** A member calls with `member.call("<module/path>:<function>", args)`
and receives the JSON the function returned. The site's owner calls the same
functions with `admin.call(...)`: the function then sees `ctx.member` null and
`ctx.owner` true, whatever collections the owner's sign-in approved, so a
function can keep administrative work to the owner with
`if (!ctx.owner) ctx.fail("ACCESS_DENIED", "...")`. Visitors call only the
exports a module opens to them (see Visitor calls); `ctx.member` null with
`ctx.owner` false and `ctx.visitor` true is a visitor.

**Transactions.** A function runs on the server in one transaction, with the
site owner's access to every collection, so keep the collections it guards
(`wallets` above) admin-written and let members read them. If it throws or
exceeds a limit, none of its writes happen, and the call fails with
`INVALID_REQUEST` (`NOT_FOUND` for a missing module or function). Documents a
function writes have no member author, so members cannot change them directly.

**Read-only exports.** A module lists the exports that only read in
`export const readOnly = ["name", ...]`, as an array of string literals: Naru
reads it when the site's files are published. Those calls cannot write and
count against the member's 120 reads a minute instead of their 30 calls. The
caller does not choose; there is one `call()`. Another form of the declaration
refuses the publication.

**Failing on purpose.** `ctx.fail(code, message, details?)` aborts the call
with one of the v1 error codes and a nonblank message of at most 1,000
characters, even if the function catches the exception and returns success.
Writes made before it roll back. `details`, at most 4 KiB of JSON, reaches the
browser as `error.details`, so a page can branch on its own reasons. The
message reaches the browser as `error.message`, unchanged, so write it for the
page's visitors:

```js
try {
  await member.call("shop:buy", { item: "sword" });
} catch (error) {
  if (error instanceof NaruError && error.details?.reason === "sold_out")
    showRestockButton();
  status.textContent = error.message; // "품절입니다."
}
```

Returning `{ ok: false }` remains valid, but is an ordinary successful return
and does **not** roll back writes. Messages and details reach the browser, so
do not include secrets. Unexpected exceptions still become `INVALID_REQUEST`.

**ctx.** `ctx` has `member` (`{ id }`, or null for the owner), `owner`, `now`
(milliseconds), `fail()`, and these
database methods, which return promises of what the SDK would, so `await` them:

- `get(collection, id)`, `getMany(collection, ids)` (at most 100, in input
  order, null where missing; one operation, as a list of 100 is), and
  `count(collection, { filter, where })`;
- `list(collection, { filter, where, sort, size, after })`;
- `add(collection, data)`, `set(collection, id, data, { condition })` and
  `delete(collection, id, { condition })`, where `condition` is
  `{ revision }` or (for `set`) `{ absent: true }`, as for the SDK's own
  writes: a mismatch fails the call with `CONFLICT`;
- `media.delete(uploadId)`: deletes one of the site's uploads once the call
  commits (see below);
- `add` and `set` take `{ secret }` (1.1.0), as a visitor's `add` does, and
  `secretMatches(collection, id, secret)` resolves whether a secret is the
  document's: a guest's password, without the app storing a hash. It counts
  toward the three password operations a call may make.

`notify(memberId, data)` and `broadcast(topic, data)` send live messages
(see Live connections); they return nothing and need no `await`. Functions
also have `URL` and `URLSearchParams`, as browsers do.

A function may be `async` or return a promise; the call ends when it settles,
and the whole call is still one transaction. Every database operation's promise
must be used: awaited, returned, chained with `then` or `catch`, or passed to
`Promise.all`. Otherwise the call fails with `INVALID_REQUEST` and rolls back,
since a mistake like `if (!ctx.get(...))` would otherwise go unnoticed.
Functions have no network or timers, and awaiting anything other than `ctx` (a
promise that never resolves) fails the call.

**Limits.** A call may make 100 database operations, 25 of them writes, send
50 live messages of at most 4 KiB each, parse 1,000 URLs, run for tens of
milliseconds and use 32 MiB of memory; its result is at most 64 KiB. A member
may make 30 calls and 120 read-only calls a minute, and members' calls count
against the site's monthly budget; the owner's do not. The module is served
like any other file of the site, so do not put secrets in it.

**Caching.** The answer names the collections the call changed; the SDK then
reads only those past shared caches, as after its own writes. A call whose
answer was lost may have changed any of them.

**Deleting uploads.** Uploads live outside the site's database, so
`ctx.media.delete(id)` queues the deletion with the call's other writes: it
happens only if the call commits, shortly after, as an owner's deletion would.
Use it where a document that referenced an upload goes away. The function must
check that the caller may delete the upload; Naru does not.

## Visitor calls (1.1.0)

A module may open exports to visitors who have signed in to nothing, by listing
them like read-only ones: `export const visitors = ["post", "edit", "list"]`.
A page calls them with `naru.call(...)`, no sign-in needed; every other export
answers a visitor with `AUTH_REQUIRED`. The function sees `ctx.visitor` true and
`ctx.member` null, and keeps the owner's access to collections, so it decides
what a visitor may do and what they see. A guest board with passwords:

```js
// _naru/functions/guest.js
export const visitors = ["post", "edit", "list"];
export const readOnly = ["list"];

export async function post(ctx, { name, text, password }) {
  const doc = await ctx.add("guestbook", { name, text }, { secret: password });
  return doc.id;
}

export async function edit(ctx, { id, text, password }) {
  const doc = await ctx.get("guestbook", id);
  if (!doc || !(await ctx.secretMatches("guestbook", id, password)))
    ctx.fail("ACCESS_DENIED", "비밀번호가 맞지 않습니다.");
  await ctx.set("guestbook", id, { ...doc.data, text });
}

export async function list(ctx) {
  const { documents } = await ctx.list("guestbook");
  return documents.map(({ id, data }) => ({
    id,
    name: data.name,
    text: data.text,
  }));
}
```

```js
const entries = await naru.call("guest:list");
```

Keep the collection admin-written, so visitors reach it only through the
function. The password is the document's secret: Naru keeps it as a salted
PBKDF2-SHA256 hash beside the document, never in its data, and
`ctx.secretMatches` checks it; a call may check three.

A visitor's calls are limited by their address: 20 a minute that may write and
60 read-only ones, and 300 and 900 a minute for all of a site's visitors. They
count against the site's monthly budget. A visitor's call cannot delete uploads
(`ctx.media.delete`). Everything else, limits included, is as for members.

## Guest edits with a secret (1.1.0)

A visitor who adds a document can give it a secret, as guests give a password
to a board post, and later change or delete it with the same secret, without
a site function:

```js
const posts = naru.collection("guestbook"); // write access: create
const post = await posts.add({ name: "Visitor", text: "Hi" }, { secret: pw });
await posts.set(post.id, { name: "Visitor", text: "Edited" }, { secret: pw });
await posts.delete(post.id, { secret: pw });
```

Naru keeps only a salted PBKDF2 hash, never returned or readable. In a
`create` collection, the matching secret is what lets a visitor replace or
delete a document; a document added without one stays the owner's. A
collection rule decides itself: `canWrite` receives `secret`, `true` when the
request's secret matched the document's, `false` when it did not, and `null`
when either has none. A secret is 1–256 characters; member and owner handles
take it too.

## Managed uploads (1.1.0)

`media.upload(file, { managed: true })` makes an upload the site's documents
keep alive: any document whose JSON contains the upload's URL, in a plain
field or inside HTML, holds a reference, from any write path (pages,
functions, batches). When the last reference goes, by an edit, a deletion or
a deleted collection, Naru deletes the upload, within about fifteen minutes;
an upload no document has used an hour after it was made is deleted too.
`ctx.media.delete(id)` still deletes one at once. Uploads made without
`managed` are unchanged: they stay until deleted.

## Live connections (1.1.0)

Pages can hear what site functions send instead of asking again on a timer.
`naru.live()` listens to topics, as anyone may; `member.live()` also hears what
functions send that member:

```js
const live = member.live({
  topics: ["board"],
  onMessage(message) {
    if (message.type === "notice") showUnread(message.data);
    if (message.type === "topic") refreshBoard();
  },
  onStatus(status) {
    if (status === "open") refreshEverything(); // nothing is replayed
  },
});
// later: live.close();
```

```js
// _naru/functions/messages.js
export async function send(ctx, { to, body }) {
  await ctx.add("messages", { from: ctx.member.id, to, body });
  ctx.notify(to, { unread: true });
}
```

`ctx.notify(memberId, data)` reaches that member's open connections;
`ctx.broadcast(topic, data)` reaches every connection listening to the topic,
including visitors', so broadcast only what anyone may read. Messages leave
only after the call commits: a failed call sends nothing. Nothing is stored or
replayed, so treat a message as a reason to read, and read again whenever the
connection (re)opens.

A connection listens to at most eight topics, which are names like collection
names. It reconnects by itself with growing pauses, and stops for good when
`close()`d or when the member's access ends (a ban, or approval withdrawn).
Opening a connection counts as one request against the site's monthly budget;
an idle connection costs nothing. A site holds at most 1,000 connections at once.

## Documents, pages, and queries

`get`, `add`, and `set` return a document envelope; `list` returns a page of
these same envelopes. Write results contain the data actually stored by the server,
including for create-only visitors (their new document only):

```ts
interface Document<T> {
  id: string;
  data: T;
  createdAt: string;
  updatedAt: string;
  revision: Revision;
  createdBy: string | null; // 1.1.0: the member who created it, or null
}

interface Page<T> {
  documents: Document<T>[];
  nextCursor: string | null;
  totalCount?: number;
}
```

Filters are ANDed predicates on top-level user fields. A value is either scalar
equality or a range with `gt`, `gte`, `lt`, and/or `lte`. For anything else,
`where` (1.1.0) takes a predicate in the language collection rules use,
combined with `filter`:

```js
await posts.list({
  where: {
    any: [
      { in: ["board", ["notice", "free"]] },
      { eq: [{ metadata: "createdBy" }, member.id] },
    ],
  },
});
```

A predicate is `true`, `false`, `{ all: [...] }`, `{ any: [...] }`, or one
comparison: `eq`, `ne`, `gt`, `gte`, `lt` and `lte` take `[field, value]`,
`in` takes `[field, [1 to 100 values]]`, `has` takes `[field, value]` and
matches a data field holding an array with that value (1.1.0):
`{ has: ["tags", "spring"] }`, and `contains` takes `[field, text]` and
matches a string data field with that text in it, 1–100 characters, A–Z in
either case (1.1.0): `{ contains: ["title", "spring"] }`, a board's search.
`contains` reads every document the rest of the query leaves, so narrow it
with a `filter` on a large collection. A field is a top-level data field,
or `{ metadata: "id" | "createdBy" | "createdAt" | "updatedAt" }`; the two
times (1.1.0) take a UTC ISO string, `"2026-10-16T09:00:00.000Z"`, and use the
collection's time indexes. Values match only their own JSON type, a
missing field matches only `ne`, and ranges compare strings or numbers. At most
100 nodes, ten levels deep, and 4 KiB as sent. `count({ filter, where })` takes
it too, and so do `ctx.list` and `ctx.count`. Sorting accepts one or
two `[field, "asc" | "desc"]` entries. User fields are strings; metadata is
`{ metadata: "id" | "createdAt" | "updatedAt" }`, where the ID may only be the
sole key. Without `sort`, and after the last key, documents are in ID order. `size` is 1–100
and defaults to 50. `totalCount` is returned only when `includeTotal` was
requested.

Ascending field order is: missing/null/non-scalar values (one tied group),
strings, numbers, then booleans (`false` before `true`). Strings compare by
Unicode code point, without locale rules or normalization; numbers compare
numerically. Descending reverses this order. ID ties use ASCII order in the
last sort key's direction; the default is ID ascending. Arrays and objects
can be stored but are not meaningfully ordered. String ranges use the same
code-point comparison. Prefer one consistent scalar type per sortable field.

`nextCursor` is opaque and bound to its original site, collection, filter,
`where`, and sort. Pass it unchanged as `after`. Pagination is not a snapshot across
separate requests, so concurrent writes can change later pages.

Two helpers are built on `list`. `count({ filter })` resolves with how many
documents match, from a one-document page with its total. `pages(options)` is
an async iterable of every page in turn, following `nextCursor` from `after`
(or the start) with the same options; stop early with `break`. It is not a
snapshot either. Walk a collection anyone can write to only as far as needed.

```js
const drafts = await posts.count({ filter: { published: false } });
for await (const page of posts.pages({ sort: [["date", "desc"]], size: 100 }))
  render(page.documents);
```

## Revisions and atomic batches

Revisions are opaque concurrency tokens. Store and return them unchanged; their
text has no public format. `{ revision }` performs optimistic concurrency, while
`{ absent: true }` permits creation only when the ID is unused; a delete takes
only `{ revision }`, since deleting only when absent could never do anything.

`admin.batch(writes)` atomically commits ID-addressed replacements and
deletions across authorized collections:

```js
await admin.batch(
  [
    {
      collection: "posts",
      set: { id: "hello", data: post, condition: { revision } },
    },
    {
      collection: "categories",
      set: { id: "news", data: category },
    },
  ],
  { signal },
);
```

It resolves with one entry per write, in order: `{ id, revision, createdAt,
updatedAt }` for a `set`, which a later conditional write can quote without
reading the document back, and `null` for a `delete`. Any failed condition or
write rolls back every write in the batch. Conditions are checked as they are
for single writes, before anything is sent. The SDK does not automatically
retry writes or batches.

## Local development (naru-dev)

From a checkout of Naru, `pnpm naru-dev <site folder> --site <name>` (in
`control-plane/`, after `pnpm install` there and in `edge/`) runs one site
locally on http://localhost:4000: the real edge Worker under `wrangler dev`
for documents, rules, functions, live connections and limits, and a stand-in
for naru.pub that serves the site's files and the SDK, signs owners and
members in on one click (members are named test accounts with a status),
keeps uploads in a folder and republishes `_naru/` on every change. Pages keep
importing `https://naru.pub/sdk/1.1.0/naru.js`; an import map sends them to
the local SDK, and uploads keep their `https://media.naru.pub` addresses,
served locally by a service worker. Data persists in `<site>/.naru-dev/`.

## Media and sign-out

```js
const media = await admin.media.upload(file, {
  signal,
  onProgress(progress) {
    if (progress.phase === "uploading")
      bar.value = progress.loaded / progress.total;
  },
});
await admin.signOut();
admin = null;
```

`upload` returns `{ url, name, contentType, size }` as stored: shrinking may
have renamed and re-encoded the file (HEIC becomes WebP, for instance).
The SDK may resize supported images before upload. Naru does not store HEIC,
so a HEIC photo in a browser that cannot convert it (only Safari can today)
throws a `TypeError` before a request is made. Which other types Naru stores is
the server's to decide; a refused type fails with `INVALID_REQUEST`.

`onProgress` is called with `{ phase: "preparing" }` while a photo is shrunk
and the upload authorized, then `{ phase: "uploading", loaded, total }` as the
bytes go to storage (`total` is the size actually sent, after shrinking), then
`{ phase: "finishing" }` while storage confirms and Naru records the file.
`loaded` can reach `total` before storage answers, and a small file may report
only its start and end. An error thrown by the handler is reported like any
uncaught error and does not stop the upload. The website SDK deliberately
does not list or delete media; owners do that in Naru's media library. Sign-out
forgets the tab's session before requesting remote revocation, and the admin
handle refuses every later call with `AUTH_REQUIRED` even if the revocation
request fails.

## Errors and cancellation

Service failures are `NaruError` instances. Application logic should use the stable
`code`, not HTTP status or message:

| Code              | Meaning                                                         |
| ----------------- | --------------------------------------------------------------- |
| `CONFLICT`        | A revision or absence condition failed.                         |
| `QUOTA_EXCEEDED`  | The site's database or media storage is full.                   |
| `AUTH_REQUIRED`   | An owner's or member's sign-in is missing, expired, or revoked. |
| `ACCESS_DENIED`   | The collection policy or admin scope denies the operation.      |
| `NOT_FOUND`       | The requested site, collection, document, or media is absent.   |
| `RATE_LIMITED`    | The caller must wait before retrying.                           |
| `INVALID_REQUEST` | Input is malformed or outside documented limits.                |
| `UNAVAILABLE`     | The service, network, or response is temporarily unusable.      |

In 1.1.0 `error.message` is a short Korean sentence written for the page's
visitors, so a page can show it as is:

```js
try {
  await member.call("shop:buy", { item: "sword" });
} catch (error) {
  status.textContent = error.message; // "품절입니다.", "권한이 없습니다." …
}
```

A site function's `ctx.fail` message is used as written; every other failure
gets Naru's wording for its code (`AUTH_REQUIRED`: "로그인이 필요합니다. 다시
로그인해 주세요."). The wording may change. Naru's English account of what went
wrong, for developers, is `error.cause.message`, and a network failure's
original error is `error.cause.cause`. In 1.0.0 `error.message` is that English
account and a network failure's original error is `error.cause`. Only the SDK creates `NaruError`s; check
them with `instanceof`. There is no `retryable` flag and no automatic retry:
a lost response can mean a write succeeded, so retrying `add()` can duplicate
it. Reconcile a failed write before trying again.

Invalid names, IDs, malformed conditions (single or batched), and non-JSON
document values throw `TypeError`.
Documents accept null, booleans, strings, finite numbers, dense arrays, and plain
objects containing these values. Undefined, functions, symbols, bigint, dates,
class instances, accessors, sparse arrays, and cycles are refused before sending.
Convert dates to strings explicitly. This checks JSON values, not your schema;
applications still validate their fields. Other malformed requests fail with
`INVALID_REQUEST`. Passing an `AbortSignal` cancels the request and rejects
with the platform's native `AbortError`, not `NaruError`. Cancellation does not
roll back a write the server already accepted.

## Compatibility guarantees

The declarations export only what an application names itself: `createNaru`,
`NaruError`, `NaruErrorCode`, `NaruClient`, `Admin`, `Document`, `Page`,
`ListOptions`, `Filter`, `Sort`, `WriteCondition`, `Revision` and `Json`, and
from 1.1.0 `Member` and `Collection`, the one handle on a collection for
visitors, members and the owner alike. Other option and result shapes are
written out in place.

1.0.0 named that handle `PublicCollection` (a visitor's) and `AdminCollection`
(the owner's). 1.1.0 keeps both as deprecated names for `Collection`, so 1.0.0
code compiles unchanged; new code names `Collection`.

Naru v1 guarantees the public TypeScript shapes and behavior described here:

- cursors and revisions remain opaque;
- each request observes a consistent result, but pages are not a shared snapshot;
- transactions are all-or-nothing;
- anonymous reads may be served from a short shared cache;
- after a write, the same loaded SDK bypasses caches for that collection for
  the remainder of its lifetime, including when the write response was lost;
  the server's cache duration is private. Reads can also see later writes by
  others; this is not a snapshot or a guarantee that your value remains unchanged;
- authenticated reads, writes, and errors are not shared-cacheable;
- `NaruError.code` is the compatibility boundary for service failures;
  the code list above is closed for v1.

Collection names starting with `_` are reserved and cannot be created.

The SDK talks to a versioned wire protocol (`/api/data/v1/…`), which Naru keeps
compatible for every released 1.x SDK file. It is documented for Naru's own
maintenance in [database.md](database.md#internal-http-protocol); applications
should use the SDK. Revision and cursor encoding, admin-token storage, upload
choreography, database technology, cache implementation, and HTTP status values
are private and may change.

### Batch document reads (1.1.0)

`collection.getMany(ids, { signal })` is available on public, member and owner
handles. It accepts up to 100 IDs, returns documents in input order (including
duplicates), and uses one HTTP request and one document query. Missing documents
and documents hidden by collection rules return `null`. Collection-level denial
still rejects the request. Ordinary membership, scope, budget and cache rules
apply. Store the results by ID to replace repeated nickname or item lookups.

```js
const profiles = await member.collection("profiles").getMany(authorIds);
```

The optional `ids` query on the existing collection GET is additive; requests
without it and the frozen SDK 1.0.0 remain unchanged.
