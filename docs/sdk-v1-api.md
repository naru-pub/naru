# Naru Data SDK v1 API reference

Naru Data is a dependency-free browser ES module for JSON documents and media
owned by one Naru site. Import the versioned module and create one client:

```js
import { createNaru, NaruError } from "https://sdk.naru.pub/sdk/1/naru.js";

const naru = createNaru({ site: "alice" });
```

`site` may be omitted (or empty) on a `*.naru.pub` site. The module's matching
TypeScript declarations are at `https://sdk.naru.pub/sdk/1/naru.d.ts`.

`/sdk/1/` stays on stable 1.0.0, whose bytes are frozen. The public `/docs`
guides also describe 1.0.0. SDK 1.1.0 remains in development; its members,
site code (queries, mutations, routes and live queries) and newer APIs require
importing `/sdk/1.1.0/naru.js` explicitly. Its collections are 1.0.0's.

## Start with reading

Create a `posts` collection in the control panel, enable public reading, and
save a document with a `title`. Add this to a page hosted on your Naru site:

```html
<ul id="posts"></ul>
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1/naru.js";
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

Next, learn admin sign-in to edit posts, then members and site code for a
community, then pagination, and finally revision conditions and atomic
batches. No API key or
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
    "posts": { "read": "world", "write": "admin", "indexes": ["category"] },
    "profiles": { "read": "admin", "write": "admin", "unique": ["nick"] },
    "guestbook": { "read": "world", "write": "create" }
  }
}
```

`read` is `admin` or `world`; `write` also takes `create`. `unique` names up
to three fields no two documents may share: a write that would repeat one's
string or number value fails with `CONFLICT` and
`details: { unique: "<field>" }`, which SDK 1.1.0 words as a value already in
use rather than a concurrent change. `read` and `write` are required, so the
file states who can reach every collection; an entry without them, or with
any other key, fails the whole file. `unique` and `indexes` may be left out.
`indexes` names up to five top-level fields reads filter on often
(`"indexes": ["category", "author"]`): a list that filters on one, newest or
oldest first, reads only its page instead of every document. Each adds a
little to every write in its collection, and an index does not help sorting
on another field. When the file arrives (a template applied, a GitHub deploy,
a save in the editor) Naru creates the collections the site lacks with these
settings, and applies a change to existing collections' indexes alone at
once, since an index opens nothing to anyone. Other changes to existing
collections wait for the owner, who sees them on /database and applies them
with one click. The file works with any SDK version, and sites without it are
unaffected. naru-dev (`npx @naru-pub/dev`) installs it too, changes included.

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
Any Naru account with a supporter plan can be a member of any site with the
database; there is nothing to register. Members are what a community site is
made of: the site's own code (see Site code) knows which member calls and
decides what each may see and do.

```js
let member = await naru.members.session();
if (!member) {
  await naru.members.signIn();
  // The browser leaves for Naru and comes back to this page, query included.
}
const posts = await member.query("board:posts", { board: "free" });
await member.mutate("board:write", { board: "free", title: "Hello" });
```

`member.id` is the member's ID on this site, the same on every visit. It is
not their Naru account name or email, which the site never receives, and
another site sees a different ID for the same account. Keep display names in
one of the site's tables, keyed by that ID.

A member sign-in lasts across every page and tab of the site, in its
`localStorage`, until the member signs out, signs out of Naru, or leaves it
unused for seven days; it ends 30 days after signing in regardless. A
member's handle has `id`, `query()`, `mutate()`, `subscribe()`,
`media.upload()`, `media.delete()` and `signOut()`. It has no `collection()`:
collections are the owner's and visitors', exactly as in 1.0.0, and a request
with a member's token on a collection is refused with `ACCESS_DENIED`.
`naru.collection()` stays anonymous after a member signs in, so a page still
reads `world` collections as any visitor does.

Members upload into the site's media, a limited number of files an hour
each, and delete their own uploads by ID (`member.media.delete(id)`). They
cannot batch, list media, or change collections. A member's mutations are
rate limited per member, and members' requests count against the site's
monthly budget like visitors'.

**Roles.** A site gives its members roles, names such as `staff` or
`level3`: the owner sets them on the control panel, and a mutation with
`ctx.setRoles(memberId, roles)`. The site's code reads the caller's as
`ctx.member.roles` and anyone's with `ctx.rolesOf(ids)`. Roles mean nothing
to Naru; they are for the site's code to check.

A sign-in that was denied, took longer than ten minutes, or could not be
completed resolves `session()` with `null`. Members need a Naru supporter
plan, unless Naru has exempted the site: an account without one is asked to
support Naru on Naru's sign-in page, and a member whose plan has ended gets
`ACCESS_DENIED` until it resumes. A site may also require approval of new
members, and may ban them ([site membership](site-membership.md)).

An owner's and a member's sign-in can share a page: each only finishes the
sign-in this tab started for it.

## Site code (1.1.0)

Rules a browser must not decide, such as who may edit a post, prices,
balances, stock or dice, run on Naru as the site's own code over its own
tables. They live in the site's files under `_naru/`:

| Folder                   | Holds                                               |
| ------------------------ | --------------------------------------------------- |
| `_naru/migrations/*.sql` | SQL that creates and changes the site's tables.     |
| `_naru/queries/`         | Exports that read, called with `query()`.           |
| `_naru/mutations/`       | Exports that write, called with `mutate()`.         |
| `_naru/routes/`          | Opt-in server-rendered pages (see Routes).          |
| `_naru/modules/`         | Shared code the others import; it cannot be called. |

```sql
-- _naru/migrations/0001_board.sql
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  board TEXT NOT NULL,
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX posts_board ON posts (board, id);
```

```js
// _naru/queries/board.js
export async function posts(ctx, { board }) {
  const { rows } = await ctx.sql`
    SELECT id, author, title, created_at FROM posts
    WHERE board = ${board} ORDER BY id DESC LIMIT 50`;
  return rows;
}
```

```js
// _naru/mutations/board.js
export async function write(ctx, { board, title }) {
  if (!ctx.member) ctx.fail("AUTH_REQUIRED", "로그인이 필요합니다.");
  if (board === "notice" && !ctx.member.roles.includes("staff"))
    ctx.fail("ACCESS_DENIED", "공지는 운영진만 쓸 수 있습니다.");
  const { rows } = await ctx.sql`
    INSERT INTO posts (board, author, title, created_at)
    VALUES (${board}, ${ctx.member.id}, ${title}, ${ctx.now})
    RETURNING id`;
  return rows[0].id;
}
```

```js
const posts = await naru.query("board:posts", { board: "free" });
```

**Names.** A call names `"<module/path>:<export>"`:
`query("community/boards:list")` runs the `list` export of
`_naru/queries/community/boards.js`, and `mutate()` the same under
`_naru/mutations/`. Each path segment must be a plain name; empty segments,
traversal and backslashes are rejected. A module may be `.js` or `.mjs`, not
both under one name. An export takes `(ctx, args)`; a call without arguments
passes `undefined`, so default parameters apply.

**Who calls.** Anyone may call a query or mutation, and the code decides what
each caller may see and do. `naru.query()` and `naru.mutate()` call as a
visitor, signed in to nothing: `ctx.visitor` is true and `ctx.member` null.
`member.query()` and `member.mutate()` call as that member: `ctx.member` is
`{ id, roles }`. `admin.query()` and `admin.mutate()` call as the owner:
`ctx.owner` is true and `ctx.member` null, whatever collections the owner's
sign-in approved, so a page that manages the site only through its code signs
in with no collections. Naru refuses a call only for the caller's standing (a
pending or banned member, a spent budget or limit), so keep owner work to the
owner with `if (!ctx.owner) ctx.fail("ACCESS_DENIED", "...")`.

**Transactions.** A call runs on the server in one SQLite transaction. If it
throws, calls `ctx.fail`, or exceeds a limit, nothing it wrote is kept, and
the call fails with `INVALID_REQUEST` (`NOT_FOUND` for a missing module or
export, and a failed `ctx` operation's own code, such as `QUOTA_EXCEEDED`). A
query's `ctx.sql` only reads; a write in a query fails it. While Naru's
server is away, every call fails with `UNAVAILABLE`.

**Failing on purpose.** `ctx.fail(code, message, details?)` aborts the call
with one of the v1 error codes and a nonblank message of at most 1,000
characters, even if the code catches the exception and returns success.
Writes made before it roll back. `details`, at most 4 KiB of JSON, reaches the
browser as `error.details`, so a page can branch on its own reasons. The
message reaches the browser as `error.message`, unchanged, so write it for the
page's visitors:

```js
try {
  await member.mutate("shop:buy", { item: "sword" });
} catch (error) {
  if (error instanceof NaruError && error.details?.reason === "sold_out")
    showRestockButton();
  status.textContent = error.message; // "품절입니다."
}
```

Returning `{ ok: false }` remains valid, but is an ordinary successful return
and does **not** roll back writes. Messages and details reach the browser, so
do not include secrets. Unexpected exceptions still become `INVALID_REQUEST`.

**ctx.** Its types are in `https://sdk.naru.pub/sdk/1.1.0/functions.d.ts`, written
by hand beside the generated `naru.d.ts` (`Query`, `Mutation`, `QueryCtx`,
`MutationCtx`, `CallingMember`, `SqlValue`, `SqlResult`, `ErrorCode`, `Json`).
`ctx` has `member`, `owner`, `ownerName` (the site's owner's Naru login,
whoever calls), `visitor`, `now` (milliseconds, fixed for the whole call),
`fail()`, `media.types` (the types Naru Media stores; pages have them as the
SDK's `MEDIA_TYPES`), `session` (below, or null), and these methods, which
return promises:

- `sql`, one statement against the site's own tables: as a tag,
  ``ctx.sql`... ${value}` `` binds every interpolated value as a parameter;
  `ctx.sql(text, values)` runs a query builder's compiled statement. It
  resolves `{ rows, changes }`. `SELECT`, `VALUES`, `INSERT`, `REPLACE`,
  `UPDATE` and `DELETE` run (`RETURNING` included); schema changes belong in
  migrations. Naru's own tables, pragmas, attaching, triggers, transactions
  and recursive queries are refused. A statement that runs too long is
  stopped (see **SQL limits**).
  It binds at most 100 values and returns at most 1,000 rows and 1 MiB; a
  `Uint8Array` binds as a
  BLOB, and BLOB columns come back as `Uint8Array`s. A
  value a `UNIQUE` column already holds fails the call with `CONFLICT`,
  `details.unique` naming the column; any other mistake is SQLite's refusal,
  with its message;
- `rolesOf(ids)`, members' roles by ID, at most 100 IDs; a member without
  any has `[]`;
- `membersWithRole(role, { after, limit })`, the members holding a role by
  member ID, up to `limit` (at most 100) after `after`, as
  `{ members, next }` (`next` null at the end);
- `counters.get(name, keys)` and `counters.increment(name, key, by = 1)`,
  counts Naru keeps beside the site's tables, by a name (1–64 of letters,
  digits, `_ . : -`) and a key, at most 100 keys a read. A query may count,
  so a page reading a post can count its view in the same call; no count
  re-runs a live query, a live query's re-run counts nothing, and counts go
  into restore points with the site's tables. In mutations only,
  `counters.delete(name, key?)` forgets a key's count, or every count of a
  name;
- `media.get(urlOrId)`, one of the site's uploads as Naru Media recorded it
  when it was finished: `{ id, url, member, name, type, size, createdAt }`
  (`member` null for the owner's), or null for any other address. Naru
  records each upload as it is finished and every one again whenever the
  owner opens the media library;
- `session.get(key)`, `session.set(key, value, { ttl })` and
  `session.delete(key)`: what one browser's calls share for a while. The
  browser SDK sends a random ID of its own (kept in `localStorage`) with each
  query and mutation as `Naru-Session`; calls without one (live queries,
  older pages) have `session` null. Values are at most 4 KiB of JSON, 100 a
  browser, each kept `ttl` seconds (a day unless given, 30 days at most). The
  browser chooses its ID, so use a session for things such as counting a view
  once, never to decide who may do what;
- `passwords.verify(password, hash, key)`, whether a guest's password
  matches a hash the site kept. Each `key` (such as `"post:42"`) accepts ten
  wrong passwords an hour, whoever tries; then every check of it fails with
  `RATE_LIMITED`;
- in mutations only, `passwords.hash(password)`, a salted PBKDF2-SHA256 hash
  of a 1–256 character password to keep in a table, and
  `setRoles(memberId, roles)`, which replaces a member's roles (at most 16
  names; `[]` clears them) if the mutation returns.

Every promise a `ctx` method returns must be used: awaited, returned,
chained with `then` or `catch`, or passed to `Promise.all`. Otherwise the call
fails with `INVALID_REQUEST` and rolls back, since a mistake like
`if (!ctx.passwords.verify(...))` would otherwise go unnoticed. Awaiting
anything other than `ctx` (a promise that never resolves) fails the call.

**The runtime's globals.** Queries, mutations and routes run in QuickJS, not
in a browser or Node. They have the JavaScript language's own globals
(`Object`, `Array`, `JSON`, `Math`, `Date`, `RegExp`, `Map`, `Set`, `WeakMap`,
`WeakSet`, `WeakRef`, `Promise`, `Proxy`, `Reflect`, `Symbol`, `BigInt`,
`Iterator`, `ArrayBuffer`, `DataView` and the typed arrays including
`Float16Array`, the `Error` types, `encodeURIComponent` and the other URI
functions, `parseInt` and the like), and besides them:

- `URL` and `URLSearchParams`, as browsers have them (at most 1,000 parses a
  call);
- `structuredClone(value)`, for primitives, plain objects and arrays, `Date`,
  `RegExp`, `Map`, `Set`, `ArrayBuffer` and `Uint8Array`, keeping cycles;
  anything else (functions, class instances, other typed arrays) throws a
  `DataCloneError`;
- `Math.random()`, from the host's random source;
- `Date` and `Date.now()`, the server's clock; prefer `ctx.now`, fixed for
  the call. Local time is the server's, which need not be Korea's: use
  `toISOString()` or the `getUTC…` methods and add the offset you want;
- `performance.now()`, `queueMicrotask`, `DOMException`.

There is no `Intl` (`toLocaleString` formats as English, without grouping),
no `TextEncoder` or `TextDecoder`, no `atob` or `btoa`, no `crypto` (hash
guest passwords with `ctx.passwords`), no `console` (`console.log` throws a
ReferenceError; return what you want to see, or `ctx.fail` with `details`),
no `fetch` or other network, no `setTimeout` or other timers, and no
`WebAssembly`, `require` or `process`. Strings have `normalize`,
`localeCompare` and Unicode property escapes (`/\p{L}/u`).

**Guest passwords.** Visitors can post and later edit with a password, as on
a guest board. The site keeps the hash in its own table and never returns it:

```js
// _naru/mutations/guest.js
export async function post(ctx, { name, text, password }) {
  const hash = await ctx.passwords.hash(password);
  const { rows } = await ctx.sql`
    INSERT INTO guestbook (name, text, password, created_at)
    VALUES (${name}, ${text}, ${hash}, ${ctx.now}) RETURNING id`;
  return rows[0].id;
}

export async function edit(ctx, { id, text, password }) {
  const { rows } =
    await ctx.sql`SELECT password FROM guestbook WHERE id = ${id}`;
  const key = `guestbook:${id}`;
  if (
    !rows.length ||
    !(await ctx.passwords.verify(password, rows[0].password, key))
  )
    ctx.fail("ACCESS_DENIED", "비밀번호가 맞지 않습니다.");
  await ctx.sql`UPDATE guestbook SET text = ${text} WHERE id = ${id}`;
}
```

**Limits.** A call may make 100 database operations (each `ctx.sql`
statement, writes included), three password hashes or checks and 1,000 URL
parses, read at most 500,000 rows in all, run for tens of milliseconds in
32 MiB of memory, and return at most 1 MiB of JSON. Queries are limited as
reads are: 600 a minute per member, or per address for visitors. A member may
make 30 mutations a minute; visitors 20 a minute per address and 300 a minute
for the whole site. Members' and visitors' calls count against the site's
monthly budget; the owner's do not. The files under `_naru/` are served like
any other file of the site, so do not put secrets in them.

**SQL limits.** Naru does not check a statement's plan before it runs; a
slow statement is stopped instead. Each `ctx.sql` statement is held to these
limits:

| Limit                  | Value                                      |
| ---------------------- | ------------------------------------------ |
| Bound values           | 100 per statement                          |
| Rows and size returned | 1,000 rows and 1 MiB per statement         |
| Rows read              | 500,000 per call, all statements together  |
| Statement time         | 3 seconds for any one step of a statement  |
| Stopped statements     | 3 stops in a minute pause it for 5 minutes |

SQLite's rows read are counted when each statement finishes; the call fails
after the statement that went past 500,000. Naru's runtime stops a statement
once SQLite has worked on it for 3 seconds without handing back a row (one
`sqlite3_step`; a statement returning many rows quickly is not stopped): the
call fails with 400 `INVALID_REQUEST`, "This statement ran longer than 3
seconds and was stopped; give it an index or read less." A stopped read fails
only its call. A stopped write (an `INSERT`, `UPDATE` or `DELETE`) also rolls
back everything the call wrote and restarts the site's database object: the
call fails the same way, and the next request finds the site as it was before
the call. While a statement runs, requests to other sites on the same Naru
runtime wait for it, so a statement stopped 3 times within a minute is
paused: the same statement (its text, whitespace aside) in the same query,
mutation or route of the site is then refused before it runs, for 5 minutes,
or 30 when it is paused again within the hour, with 503 `UNAVAILABLE`,
`details.reason` `"statement_paused"`, a `Retry-After` of the seconds left,
and "This statement of the site's code ran too long and was stopped 3 times
within a minute, so it is paused for N more minutes. The site's owner has been
told." The site's other statements, and other sites, are not affected. A
paused route's page answers 503 with that message. The owner sees each pause,
with its SQL, on the control panel's database page (중지된 쿼리), and can let
it run again (다시 허용); a new release lets every paused statement of the
site run again.

To stay fast as tables grow, read each table whole at most once and find the
rows of every table joined to it, and of every correlated subquery, by `=` on
a key or an index; a full-text table is best searched first (`MATCH`, `LIKE`,
`GLOB`) with the rest found by `rowid`. Patterns that stay fast:

```js
// A list as one bound value, however long.
await ctx.sql`SELECT * FROM members WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
// A row's JSON column, opened in SQL.
await ctx.sql`SELECT j.key, sum(j.value) AS n FROM visits, json_each(visits.hours) j GROUP BY j.key`;
// An ordered aggregate per row: a correlated subquery over an ordered one.
// Give it an index on titles (ch, ord), or it reads all of titles per row.
await ctx.sql`SELECT c.id, (SELECT json_group_array(title) FROM
  (SELECT title FROM titles WHERE titles.ch = c.id ORDER BY ord)) AS titles FROM chars c`;
// Past 1,000 rows: keyset paging, the next page after the last key.
await ctx.sql`SELECT * FROM items WHERE id > ${after} ORDER BY id LIMIT 1000`;
// A post's previous and next: their own statements, each reading one row
// from the index on (board, id), rather than a correlated subquery per row.
const [previous] = (
  await ctx.sql`SELECT id FROM posts WHERE board = ${board}
  AND id < ${id} ORDER BY id DESC LIMIT 1`
).rows;
const [next] = (
  await ctx.sql`SELECT id FROM posts WHERE board = ${board}
  AND id > ${id} ORDER BY id LIMIT 1`
).rows;
```

**Caching.** Queries and mutations use the site's tables, not collections:
a mutation leaves every collection's cache as it was, and a query's answer is
never cached.

**Shared code.** Files in `_naru/modules/` cannot be called; queries,
mutations and routes import them with static relative imports, extension
included (`import { price } from "../modules/prices.js"`). Package names, URL
imports, dynamic imports and top-level await are rejected. Transpile
TypeScript before uploading; bundling is unnecessary.

**Migrations.** `_naru/migrations/<name>.sql`, directly in the folder (names
of letters, digits, `_`, `.` and `-`), create and change the site's tables.
They are applied in the byte order of their names when a release of the
site's code activates, each once. A migration may create, alter and drop
tables, indexes and views, and write rows. Full-text tables are fts5
virtual tables (`USING fts5(..., tokenize='trigram')` finds Korean of three
characters or more), keeping their own content or indexing a table named by
`content=`; contentless ones, other virtual tables, temporary tables and
triggers are not supported. Naru's own names are
refused as in `ctx.sql`. What has run is history: a release that edits or
removes an applied migration, or adds one whose name sorts before the last
applied, is refused, so a fix is a new file. A migration that fails refuses
the whole release, which changes nothing: the previous code and tables stay.
So does a migration statement that runs past the 3-second statement time
(**SQL limits**), refused with "A migration ran longer than 3 seconds and was
stopped" (it does not say which migration). An index over a whole 100 MiB
table of long text takes about 1.5 seconds.
Before a release applies migrations, Naru keeps a restore point of the whole
site database; the owner can return the site to one on the control panel
(데이터베이스 → 복원 지점). A restore brings back collections, documents,
the site's tables and rows, the applied migrations and members' roles as they
were, replacing everything since, after keeping a restore point of the present
so it can be undone; a restore point that cannot be read whole changes
nothing. The owner can also keep one of the present at any time (지금 복원
지점 만들기; one at a time, three an hour) and download any of them. Restore
points, the owner's own included, are kept for seven days, then deleted: to
keep one longer, download it. The site's code stays the current release; migrations it
has that the restore point had not applied are pending again and apply with
the next release, so edit or remove one first to keep it from running.

**A restore point's file.** A download, `<site>-<name>.ndjson.gz`, is the
whole site database as gzip-compressed NDJSON: one JSON value per line, read
with `gunzip -c alice-manual-1790000000000.ndjson.gz | jq -c .` or any
NDJSON reader. The first line is
`{"type":"header","version":2,"schema":[…]}`, the `CREATE` statements of the
site's own tables, indexes and views as the migrations left them. Then one
line per row, `{"type":"row","table":…,"row":{column: value}}`: the site's
tables as `site:<name>` (a full-text table's rows carry their `rowid`; its
own storage tables are left out), Naru's tables by their names
(`collections`, `documents` with each document's JSON in `data`, `meta`,
`usage`, `media_refs`, `rate_limits` and the like) and `_naru_migrations` and
`_naru_roles` (members' roles). A value is a string, a number or null; a BLOB
is `{"$base64": …}`. The last line is `{"type":"end","rows":<count>}`: a file
without it, or with another count, was cut short. Uploads are not in it:
their files stay in Naru Media, and rows hold their URLs. Naru does not take
a downloaded file back yet; restoring is from the restore points it keeps.
The site's tables count toward the site's database quota with its
collections. naru-dev (`npx @naru-pub/dev`) writes `_naru/types/database.d.ts`, the tables
as the migrations left them, for `ctx.sql` and query builders.

**Releases.** Every change to `_naru/migrations/`, `queries/`, `mutations/`,
`routes/` or `modules/` (a save in the editor, a template applied, a GitHub
deploy) publishes a new release of these folders, applies its migrations and
switches calls to it at once. A release that fails leaves the previous one
active and the edited files in place for correction. Upload imported files
before the files that import them when uploading one at a time.

## Routes (1.1.0)

A site may answer some paths with pages rendered on Naru, for link previews,
feeds or pages that should work without JavaScript. Each file in
`_naru/routes/` answers the path it is named for, with its default export:

| File                    | Answers                       |
| ----------------------- | ----------------------------- |
| `routes/index.js`       | `/`                           |
| `routes/about.js`       | `/about`                      |
| `routes/posts/index.js` | `/posts` and `/posts/`        |
| `routes/posts/_id.js`   | `/posts/<id>`, as `params.id` |
| `routes/feed.xml.js`    | `/feed.xml`                   |

A segment starting with `_` takes any one path segment; a fixed segment wins
over it. Paths no route answers are the site's files, as before. A route's
default export receives `{ path, origin, params, query }`; `origin` is the
subdomain or custom domain the page was asked on, such as
`https://alice.naru.pub`, for absolute URLs like `og:url`.

```js
// _naru/routes/posts/_id.js
export default async function (ctx, { path, params, query }) {
  const { rows } =
    await ctx.sql`SELECT title FROM posts WHERE id = ${params.id}`;
  if (!rows.length) return { status: 404, html: "<p>없는 글입니다.</p>" };
  const title = rows[0].title.replace(
    /[&<>"]/g,
    (c) => `&#${c.charCodeAt(0)};`,
  );
  return {
    file: "post.html",
    head: `<meta property="og:title" content="${title}">`,
    cache: 60,
  };
}
```

A route runs as a visitor's query: it only reads, sees `ctx.visitor` true,
and is limited and counted as a visitor's query is. It returns a string of
HTML, or one of `{ html }`, `{ body, type }` (text such as a feed, as one of
`text/plain`, `text/css`, `text/calendar`, `text/xml`, `application/xml`,
`application/rss+xml`, `application/atom+xml` or `application/json`),
`{ file, head }` (one of the site's files, with `head` added to its
`<head>` when it is HTML) or `{ redirect }` (a path or an `https://` URL),
each with an optional `status` and `cache`, the seconds (0–300) the edge may
keep the page. Escape what goes into HTML yourself. A route that fails is
answered with a short error page; while the site's database cannot be
reached, its files answer instead.

## Live queries (1.1.0)

A page can keep a query's answer current instead of asking again on a timer.
`subscribe()` runs a query, calls back with its answer, and calls again
whenever a write changes a table the query read and the answer with it:

```js
const live = member.subscribe(
  "board:posts",
  { board: "free" },
  (posts) => render(posts),
  { onError: (error) => (status.textContent = error.message) },
);
// later: live.close();
```

`naru.subscribe()` runs the query as a visitor and `member.subscribe()` as
that member; the owner's handle has no `subscribe()`. A mutation that writes
a table the query read runs it again, and the page hears only an answer that
changed; a new release of the site's code runs every live query again.
A failure, at first or later, goes to `onError`.

A handle's live queries share one connection, opened with the first and
closed with the last. It reconnects by itself with growing pauses and asks
every query again, so the latest answer arrives once it is back; it stops for
good when the member's access ends (a ban, or approval withdrawn). A
connection holds at most 20 live queries, and a site 5,000. Opening a
connection counts as one request against the site's monthly budget, and each
query's first run as a query call; runs after writes are not counted. A site
holds at most 1,000 connections at once.

## Upload references (1.1.0)

The owner's media library marks the uploads nothing names as unreferenced
(참조 없음), and shows where the others are named. Nothing is deleted on
Naru's judgement, since media may be linked from anywhere (site files, other
sites); uploads are deleted by the owner, or by the member who made them
(`media.delete(id)`); site code cannot delete them.

- **Collection documents.** Naru records which documents name each upload:
  any document whose JSON contains the upload's URL, in a plain field or
  inside HTML, from any write path (pages and batches).
- **The site's own tables.** Nothing is recorded as site SQL writes; when the
  owner opens the media library, Naru searches every TEXT value of the site's
  tables (not full-text tables, which copy their sources, nor BLOBs) for each
  upload's ID: its URL (`https://media.naru.pub/<owner>/<id>.<ext>`), a bare
  ID as `upload()` returns it, or either inside JSON or HTML. The library
  lists the table and column of each. A row deleted or edited is seen on the
  next look. The search is bounded (8 seconds, 256 Mi characters of text): past
  that, the library says it looked at only part of the tables, and an
  upload marked unreferenced may still be named in the rest. A ~100 MiB
  database is searched whole in about half a second. The tables are searched
  at most once a minute: reopening the library within it shows the same
  answer, or, after a write, says the references are still being checked
  (documents' only until then).

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
requested. Anything richer, such as OR, search or joins, belongs in the
site's own tables and queries.

Ascending field order is: missing/null/non-scalar values (one tied group),
strings, numbers, then booleans (`false` before `true`). Strings compare by
Unicode code point, without locale rules or normalization; numbers compare
numerically. Descending reverses this order. ID ties use ASCII order in the
last sort key's direction; the default is ID ascending. Arrays and objects
can be stored but are not meaningfully ordered. String ranges use the same
code-point comparison. Prefer one consistent scalar type per sortable field.

`nextCursor` is opaque and bound to its original site, collection, filter,
and sort. Pass it unchanged as `after`. There is no offset: a numbered
page is reached by following cursors from the first, so keep the cursors a
page has seen. Pagination is not a snapshot across separate requests, so
concurrent writes can change later pages.

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

`npx @naru-pub/dev <site folder> --site <name>` runs one site locally on
http://localhost:4000, with nothing else to install
([naru-dev/README.md](../naru-dev/README.md)): Naru's real edge Worker under
workerd for collections, the site's tables, queries, mutations, routes,
live queries and limits, and a stand-in for naru.pub that serves the site's
files and the SDK, signs owners and members in on one click (members are
named test accounts with a status), keeps uploads in a folder, and
republishes `_naru/` on every change, writing `_naru/types/database.d.ts`
after each. Pages keep importing `https://sdk.naru.pub/sdk/1.1.0/naru.js`;
an import map sends them to the local SDK, and uploads keep their
`https://media.naru.pub` addresses, served locally by a service worker. Data
persists in `<site>/.naru-dev/`.

Tests start the same server with `startNaru()` from
`@naru-pub/dev/testing`, on a free port with a temporary state, and sign the
owner or a member into a Playwright page with `signIn(page, who)`. From a
checkout of Naru, `pnpm naru-dev` in `control-plane/` runs the same code
from source.

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

| Code              | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `CONFLICT`        | A revision or absence condition failed.                            |
| `QUOTA_EXCEEDED`  | The site's database or media storage is full.                      |
| `AUTH_REQUIRED`   | An owner's or member's sign-in is missing, expired, or revoked.    |
| `ACCESS_DENIED`   | The collection policy, admin scope or site's code denies it.       |
| `NOT_FOUND`       | The requested site, collection, document, code or media is absent. |
| `RATE_LIMITED`    | The caller must wait before retrying.                              |
| `INVALID_REQUEST` | Input is malformed or outside documented limits.                   |
| `UNAVAILABLE`     | The service, network, or response is temporarily unusable.         |

In 1.1.0 `error.message` is a short Korean sentence written for the page's
visitors, so a page can show it as is:

```js
try {
  await member.mutate("shop:buy", { item: "sword" });
} catch (error) {
  status.textContent = error.message; // "품절입니다.", "권한이 없습니다." …
}
```

A query's or mutation's `ctx.fail` message is used as written; every other failure
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
`ListOptions`, `Filter`, `Sort`, `WriteCondition`, `Revision`, `Json`,
`PublicCollection` (a visitor's handle on a collection) and `AdminCollection`
(the owner's), and from 1.1.0 `Member`, `SiteCode` (`query()` and
`mutate()`), `LiveQueries` (`subscribe()`) and `Live`. 1.0.0 code compiles
unchanged against 1.1.0. Other option and result shapes are written out in
place. The types of the site's own code are in `functions.d.ts` (see Site
code).

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
