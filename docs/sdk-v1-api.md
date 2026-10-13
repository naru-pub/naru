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
Any Naru account can be a member of any site with the database; there is
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
completed resolves `session()` with `null`. Naru may limit membership to
accounts with a supporter plan; then signing in shows that on Naru's page, and
a member whose plan has ended gets `ACCESS_DENIED`.

An owner's and a member's sign-in can share a page: each only finishes the
sign-in this tab started for it.

## Site functions (1.1.0)

Rules a member's browser must not decide, such as prices, balances, stock or
dice, run on Naru as site functions. Put a module in the site's files at
`_naru/functions/<module/path>.js` and export plain functions from it:

```js
// _naru/functions/shop.js
export async function buy(ctx, { item }) {
  const listing = await ctx.get("shop", item);
  if (!listing || listing.data.stock < 1) return { ok: false };
  const wallet = await ctx.get("wallets", ctx.member.id);
  if (wallet.data.balance < listing.data.price) return { ok: false };
  await ctx.set("wallets", ctx.member.id, {
    balance: wallet.data.balance - listing.data.price,
  });
  await ctx.set("shop", item, {
    ...listing.data,
    stock: listing.data.stock - 1,
  });
  await ctx.add("inventory", { owner: ctx.member.id, item });
  return { ok: true };
}
```

```js
const result = await member.call("shop:buy", { item: "sword" });
```

Module paths may use subdirectories: `member.read("community/boards:list")`
loads `_naru/functions/community/boards.js` and calls its `list` export.
Each path segment must be a plain name; empty segments, traversal and
backslashes are rejected. The colon separates the export from the file path.

A member calls `"<module/path>:<function>"` with JSON arguments, and receives the
JSON the function returned. Only signed-in members can call. A function runs
on the server in one transaction, with the site owner's access to every
collection, so keep the collections it guards (`wallets` above) admin-written
and let members read them. If it throws or exceeds a limit, none of its writes
happen, and the call fails with `INVALID_REQUEST` (`NOT_FOUND` for a missing
module or function). Use `ctx.fail(code, message)` for expected failures that
must abort the transaction. The browser receives a `NaruError` with that code
and message from either `member.call()` or `member.read()`:

```js
// Inside a site function, before or after writes:
if (listing.data.stock < 1) ctx.fail("CONFLICT", "품절입니다.");
// In the browser:
try {
  await member.call("shop:buy", { item: "sword" });
} catch (error) {
  if (error instanceof NaruError && error.code === "CONFLICT") {
    status.textContent = error.message;
  } else throw error;
}
```

`ctx.fail` accepts the existing v1 error codes and a nonblank message of at most
1,000 characters. It always aborts the call, even if the function catches the
exception and returns success. Writes made before the failure roll back.
Returning `{ ok: false }` remains valid, but is an ordinary successful return
and does **not** roll back writes. Messages reach the browser, so do not include
secrets. Unexpected exceptions still become `INVALID_REQUEST`.

`ctx` has `member.id`, `now` (milliseconds), `random()` (also behind
`Math.random`), and `get(collection, id)`, `list(collection, { filter, sort,
size, after })`, `add(collection, data)`, `set(collection, id, data)` and
`delete(collection, id)`, which return promises of what the SDK would, so
`await` them. `member`, `now`, `random()` and `fail()` are not promises.
Documents a function writes have no member author, so members cannot change
them directly. A function may be `async` or return a promise; the call ends when
it settles, and the whole call is still one transaction. Every database
operation runs as soon as it is called, so one that is never awaited still
counts, and its failure still aborts the call. Functions have no network or
timers, and awaiting anything other than `ctx` (a promise that never resolves)
fails the call. A call may make 100 database operations, 25 of them
writes, run for tens of milliseconds and use 32 MiB of memory; its result is at
most 64 KiB. A member may make 30 calls a minute, and calls count against the
site's monthly budget. The module is served like any other file of the site,
so do not put secrets in it.

Functions also have two bounded read helpers:

```js
const authors = await ctx.getMany("profiles", ["alice", "bob", "missing"]);
// Results match input order, including duplicates; missing documents are null.
const comments = await ctx.count("comments", { filter: { post: "post-id" } });
```

`getMany` accepts at most 100 document IDs and executes one document query.
Each input ID counts toward the function's 100-operation budget (an empty array
costs one operation). `count` costs one operation and executes only a SQL count,
without loading document bodies. Both work in read-only functions and see writes
made earlier in the same transaction. Like other function reads, they use owner
access; the function must enforce the caller's permissions before returning data.
These helpers add no browser routes or protocol error codes.

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
equality or a range with `gt`, `gte`, `lt`, and/or `lte`. Sorting accepts one or
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

`nextCursor` is opaque and bound to its original site, collection, filter, and
sort. Pass it unchanged as `after`. Pagination is not a snapshot across
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

`error.message` is diagnostic and may change; a network failure's original
error is the standard `error.cause`. Only the SDK creates `NaruError`s; check
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
`NaruError`, `NaruErrorCode`, `NaruClient`, `Admin`, `PublicCollection`,
`AdminCollection`, `Document`, `Page`, `ListOptions`, `Filter`, `Sort`,
`WriteCondition`, `Revision` and `Json`, and from 1.1.0 `Member` and
`MemberCollection`. Other option and result shapes are written out in place.

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
