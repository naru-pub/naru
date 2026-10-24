# Site databases (Naru Data v1)

Naru Data stores each site’s collections and JSON documents in a SQLite-backed Cloudflare Durable Object. PostgreSQL holds accounts, entitlements, website authentication, and media metadata. Static sites use a dependency-free browser ES module; owners manage data and collection permissions at `/database` in the control plane. No separate database hostname is required.

The concise public contract is documented in the [Naru Data SDK v1 API
reference](sdk-v1-api.md). This document covers setup, server operation, limits,
and the private HTTP protocol behind that interface.

## Setup

From `control-plane`, install dependencies and run `pnpm migrate` against your intended development database before starting the app. For production, run the migration as part of the normal deployment procedure before serving the new API. PostgreSQL migrations maintain accounts, website registrations, authorization-code/token hashes, and media metadata. Worker deployments maintain the per-site SQLite schema. Historical migrations remain necessary for upgrades; the removal migration refuses to drop PostgreSQL collections belonging to sites that were never moved. Such installations must migrate their data using the previous release before upgrading. Do not roll back historical migrations to restore the former document backend.

For reverse-proxy deployments, owner request checks use `SITE_DATA_CONTROL_PLANE_ORIGIN` (an origin such as `https://naru.pub`). In production it defaults to `https://${NEXT_PUBLIC_DOMAIN}`, or `https://naru.pub` if unset. Configure it explicitly if the control plane uses another hostname. This avoids trusting forwarded host headers or comparing against Next's internal localhost URL. For local production-build tests, set it to the localhost origin used by the test client.

## Permissions

Every new collection defaults to `admin` read and `admin` write. Permissions are independent:

| Read  | Write  | Public behavior                                     |
| ----- | ------ | --------------------------------------------------- |
| admin | admin  | No document access.                                 |
| world | admin  | Read published blog posts.                          |
| world | create | Read and submit comments; cannot replace or delete. |
| admin | create | Submit private messages for owner review.           |
| admin | world  | Create, replace and delete, but not read.           |
| world | world  | Read, create, replace and delete.                   |

“Admin” means the authenticated Naru site owner, not another Naru user or a global platform administrator.

Members (SDK 1.1.0, see [Site members](#site-members-sdk-110)) have no collection access: a request with a member's token on a collection is refused with 403 `ACCESS_DENIED`, and they reach the site's data through its queries and mutations. Owners retain full document access. Only the control plane can create/delete collections or change permissions; website tokens cannot do so.

`create` allows only `POST /:collection` (`add` in the SDK), with a server-generated UUID. It does not allow `PUT`, even for a previously unused ID, or `DELETE`. Creation is insert-only and never overwrites an existing document. `world` writes remain unrestricted; use `create` for guestbooks and comments. Create-only does not moderate spam or allow visitors to edit their own submissions.

Keep drafts in an admin-readable collection. A `published: false` field does not hide a document inside a public-readable collection. For moderation, accept messages into an admin-readable/create-only `submissions` collection and publish approved entries into a public-readable/admin-writable `comments` collection.

Public API calls deliberately ignore cookies. SDK requests always use `credentials: "omit"`. An explicit owner bearer token grants scoped document access after Naru login; invalid or expired credentials never fall back to public access. Control-plane requests use the existing same-origin admin session. Never embed an admin session, password or fixed token in a public site.

### Declared collections

A site's `_naru/collections.json` lists the collections it needs, with their
access, unique fields and indexed fields (format in [sdk-v1-api.md](sdk-v1-api.md)).
`purgeSiteFiles` (lib/cache-purge.ts) installs it whenever the file is among the
changed keys: `installDeclaredCollections` (lib/site-data/declared-collections.ts)
reads it from R2 and, for owners with the database feature, creates the
missing collections at once, with changes to existing collections' indexes
alone (an index is `query.ts`'s `fieldIndex`: the field, then `created_at` and
`id`, partial on the collection's ID, kept in meta as `indexes:<id>` and rebuilt
by `import` and `restore`). Other changes it would make to existing collections are
never applied there; /database shows them (`GET /api/account/collection-declaration`)
and the owner's "적용하기" applies them (`POST`), with widened access marked as
on the sign-in page. A file that does not parse is reported to Sentry and shown
on /database; nothing changes.

## Browser SDK

Create a collection in the control plane, choose its permissions, then use this in a static page. The database and its collections are created in the control plane; a page only names them. Both the SDK and the public API support CORS.

```html
<script type="module">
  import { createNaru, NaruError } from "https://sdk.naru.pub/sdk/1/naru.js";
  const naru = createNaru();
  const entries = naru.collection("guestbook");

  try {
    const { id } = await entries.add({ name: "Visitor", message: "Hello!" });
    const document = await entries.get(id);
    // set() and delete() require admin access or full public write permission.
    let cursor = null;
    do {
      const page = await entries.list({ size: 20, after: cursor });
      render(page.documents);
      cursor = page.nextCursor;
    } while (cursor);
  } catch (error) {
    if (error instanceof NaruError) console.error(error.code, error.message);
    else throw error;
  }
</script>
```

A page served from `<login>.naru.pub` belongs to that site, so `createNaru()` needs nothing else. A custom domain or local page uses `createNaru({ site: "login-name" })`. Every collection and authentication operation then comes from that one client.

`get` returns `{ id, data, revision, createdAt, updatedAt }`; a missing document throws `NaruError` with `code: "NOT_FOUND"`. `set` replaces the whole document or creates it if absent. `add` generates an opaque ID without requiring read permission. `add` and `set` return `{ id, data, revision, createdAt, updatedAt }`, so a caller rendering what it just saved uses the server's own timestamps rather than the browser clock. `delete` is idempotent and resolves with nothing. JSON null is stored as a value, not treated as deletion. Render user data with `textContent`, not `innerHTML`.

SDK declarations are available alongside the module at `https://sdk.naru.pub/sdk/1/naru.d.ts`. The SDK pins `https://naru.pub` as its control-plane origin, even when bundled/copied. It takes no option to change that; Naru's own integration tests redirect its requests to a loopback server in their `fetch` shim instead.

## Website owner login

1. Open `/database` directly in the control plane (it is intentionally absent from the header).
2. Under website administrator login, register the editor page's URL such as `https://your-login-name.naru.pub/admin.html` and select the collections it may access. A registration names a page, so it also matches the other addresses the edge serves that page at (`/` and `/index.html`; `/about`, `/about/` and `/about/index.html`). Registrations are stored as typed; only the server compares them this way, beside the edge whose routing it mirrors, and approval redirects back to the exact address the sign-in left from, where the SDK keeps its pending sign-in. The callback must be on your Naru subdomain or an active, verified custom domain; no query, fragment, credentials, wildcard or arbitrary external origin. Development mode also permits loopback callbacks.
3. Nothing else needs configuring: the site name and the callback page identify the registration. Each callback keeps independent collection permissions. Registering first is optional: when the page is not registered, asks for collections the site does not have, or asks for collections its registration lacks, the consent page offers to register it, create those collections (private, admin read and write) or add them to the registration, on the owner's explicit click, before the separate approval step. Adding collections to a registration revokes its outstanding sign-ins, as editing it in the control panel does. It offers nothing when the signed-in account is not the site's owner or the page is not on their site or verified domain.
4. Call `naru.auth.signIn({ collections })` from a button. Naru authenticates the owner and asks for explicit consent. The website resumes at the registered callback, where `naru.auth.session()` returns a separate authenticated client.

Minimal editor-page wiring:

```html
<meta name="referrer" content="no-referrer" />
<button id="login">Sign in to edit</button>
<button id="save" disabled>Publish example post</button>
<button id="logout" disabled>Sign out</button>
<p id="status"></p>
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1/naru.js";
  const naru = createNaru();
  const status = document.querySelector("#status");
  async function run(action) {
    try {
      await action();
    } catch (error) {
      if (error.code === "AUTH_REQUIRED") admin = null;
      status.textContent = error.message;
    }
  }
  // Call early on the callback page: it strips code/state from the address.
  let admin = await naru.auth.session();
  document.querySelector("#save").disabled = !admin;
  document.querySelector("#logout").disabled = !admin;
  document.querySelector("#login").onclick = () =>
    run(() => naru.auth.signIn({ collections: ["posts"] }));
  document.querySelector("#save").onclick = () =>
    run(async () => {
      await admin
        .collection("posts")
        .set("hello", { title: "Hello", body: "My first post" });
      status.textContent = "Published";
    });
  document.querySelector("#logout").onclick = () =>
    run(async () => {
      const previous = admin;
      admin = null;
      document.querySelector("#save").disabled = true;
      document.querySelector("#logout").disabled = true;
      await previous.signOut();
      status.textContent = "Signed out";
    });
</script>
```

The site name and the exact callback URL identify the registration; there is no client ID. The requested collections must be a subset of the registration. Handles from `naru.collection()` never use admin credentials; only `admin.collection()` uses admin authority. Tokens permit reading, creating, replacing and deleting documents in those collections, including private documents. They are tied to collection IDs so deleting and recreating a collection does not transfer old grants.

Authentication uses random state and mandatory S256 PKCE. The verifier and state live in tab-scoped sessionStorage for at most ten minutes; authorization codes expire after 60 seconds and are single-use, including concurrent exchanges. The server stores only code/token hashes. Each registered admin page has a control-plane token lifetime of 1-1440 whole minutes (default 1440). Each sign-in issues one opaque admin token capped by this setting, the duration displayed at consent, and the approving Naru session. The platform maximum remains 24 hours.

That lifetime is an idle window rather than a countdown to being signed out mid-edit: an accepted owner request renews the token, so a page in use keeps working. Renewal stops at whichever comes first — seven days after the token was issued, the approving Naru session's own expiry, or a lifetime the registration has since lowered — and never shortens an expiry the token already has. Like a Naru session, a token is only rewritten once it is past the halfway mark, so an active page costs one extra write per half-window. Revocation, registration changes and session deletion end a token immediately, regardless of renewal. Session storage, restoration, and expiry remain SDK implementation details; a website never sees a token deadline.

Control-plane session expiry/deletion, registration removal, token revocation, and domain status are checked on every authenticated data request. Use the control panel to revoke a page's outstanding codes and tokens, or remove its registration to disable future login. `naru.auth.session()` only finishes a sign-in that this tab started with `naru.auth.signIn()`; a page's own `?code=` or `?error=` parameters are left untouched otherwise. A sign-in that returns denied, stale or unexchangeable resolves `null` like any signed-out visit. `admin.signOut()` clears local credentials and disables that handle before requesting server revocation, so a failed revocation cannot leave the page signed in. An unusable admin session fails with `AUTH_REQUIRED`, and the next `naru.auth.session()` returns null. A network failure is `UNAVAILABLE`. This does not sign out of the Naru control plane. Never share admin authority or load untrusted scripts on an editor page.

Authorization approval and registration changes require same-origin owner requests. Token exchange and API access require the registered origin plus the explicit code/verifier or bearer token; CORS never grants authorization. The consent page disallows framing. An origin check cannot prevent use of a stolen bearer token by a non-browser client: scripts running on your editor page can exercise owner privileges while signed in. Use a minimal trusted editor without third-party scripts, avoid unsafe HTML rendering, and set a no-referrer policy on the callback page.

## Site members (SDK 1.1.0)

A member is a Naru account signed in to someone else's site. Any account can be a member of any site that has the database; a site needs nothing registered, only queries and mutations that know what members may do. The account never reaches the site: a member is a row in `site_members` (one per site and account, made at the first sign-in), and its UUID is the member ID the site sees, so two sites cannot match their members up.

Sign-in is the owner's PKCE flow without a registration:

1. `naru.members.signIn()` stores `{ verifier, state, startedAt, address }` in this tab's sessionStorage under `naru:member:<control-plane origin>:<site>:pending` and leaves for `/members/sign-in?site=&redirectUri=&challenge=&state=`. `redirectUri` is the page (origin and path) and must be one of the site's: its subdomain, an active verified custom domain, or loopback in development.
2. The page asks a signed-out visitor to sign in to or create a Naru account (`/login` and `/signup` return to it), then asks to sign in to the site as that account. Approval (`POST /api/data-auth/member-authorize`, same-origin, with the Naru session) issues a single-use code for 60 seconds, bound to the member, the approving session and the page. Denial returns `error=access_denied`.
3. `naru.members.session()` on the page exchanges it at `POST /api/data-auth/v1/member-token` with `{ code, verifier, redirectUri }` from the page's origin, and receives `{ accessToken, expiresIn, expiresAt, memberId }`. It restores the address the sign-in left from, query and fragment included, and keeps `{ accessToken, expiresAt, memberId }` in the site's localStorage under `naru:member:<control-plane origin>:<site>`, for every page and tab of the site.

Member tokens are `m.` followed by 43 base64url characters, sent as `Authorization: Bearer`, and stored as hashes in `site_member_tokens` with the origin they were issued to; a request must come from that origin, which must still be the site's. A token is an idle window of seven days, renewed past its halfway mark the way an owner token is (the same `Naru-Owner-Expires`/`-In` headers), ending 30 days after it was issued, when the approving Naru session ends, or when the account is deleted. `POST /api/data-auth/v1/member-revoke` revokes the bearer token, idempotently, from its origin. There are at most 20 pending codes and 20 live tokens per member. `cleanup-site-data-grants` sweeps expired member codes and tokens too.

Members need no supporter plan, unless Naru's operators require one of a site's members (`users.site_members_free` off, toggled on the operator's account page at `/admin/users/<site>`; it is on by default). Then they need a plan (comp, paid, or within the payment grace): the sign-in page asks others to become supporters, approval and exchange refuse them, and every member request checks it, so a member whose plan ends, or whose site comes to require one, is refused with 403 `ACCESS_DENIED` until that changes back, without signing in again.

Member requests always go through the control plane, which resolves the token, refuses it on collections (`executeData`) and `_batch`, and otherwise tells the site's object the member ID. The object counts a member's mutations in fixed-minute buckets of 30 per member and their queries against 600 reads a minute (visitors' address buckets do not apply to them), and counts their requests against the site's monthly budget like visitors'. Members cannot list media or delete uploads but their own. Their roles, names the site gives them, are kept in the site's object (`_naru_roles`, at most 16 per member), set by the owner on the control panel (`rolesOfMembers`, `setMemberRoles`) or by a mutation's `ctx.setRoles`.

A mutation's `ctx.notify(memberIds, { title, body, path })` (`edge/src/notify.ts`) queues a row in the site's `_naru_notify_outbox` in the call's transaction (not in dumps; 1,000 recipients a call; at most 10,000 waiting, beyond which new ones are dropped and logged, not refused) and adds the site to the Worker's pending set, which an object restarting with rows left in its outbox adds back (`site_name` in its meta). The control plane's worker (`watchAppNotifications`, every two seconds, with the every-minute `app-notifications` job as backstop; `control-plane/src/lib/app-api/delivery.ts`) reads `POST /v1/notifications/pending` (merged across shards by the router), then each site's `notifyOutbox`, resolves member IDs to accounts through `site_members`, stores, pushes and calls `ackNotifyOutbox`, which takes the site off the set once its outbox is empty. The app side is in [the Naru app's design](design/naru-app.md).

Members upload into the site's media through the owner's routes (`POST /_files`, then `PUT /_files/:id`). `site_data_files.member_id` records who uploaded what; a member finalizes only their own uploads and may authorize 30 files an hour. The site's quota applies as it does to the owner.

### Site code

A site's queries and mutations (SDK 1.1.0) are `POST /api/data/v1/:site/_query/<module/path>:<export>` and `POST /_mutate/<module/path>:<export>` with `{ args }`, answered with `{ result }` (200: the export's own JSON, not translated like documents). Without a token the call is a visitor's, answered at the edge like a visitor's read (`SiteData.visit`, falling back to the control plane). With a member token or an owner token the edge sends it on to the control plane, which resolves the caller (`executeCall`) and calls the site's object (`call`, with `member` null for the owner); the control panel's own session cannot call. The object loads `queries/`, `mutations/` or `routes/<module/path>.js` (or `.mjs`) and its imports from the site's active release (`edge/FUNCTION-IMPORTS.md`) and runs the export in QuickJS-ng compiled to WebAssembly (`edge/src/functions.ts`), synchronously inside one SQLite transaction. A query or route runs with `ctx.sql` read-only.

Admission, before the code runs and counted even if the call then fails: a member's or visitor's query is a read (`spend("member_query")`/`"visitor_query"`, then `limitReader`: 600 a minute per member or address); a member's mutation is `member_call`, 30 a minute per member (`limitMember`); a visitor's is `visitor_call`, 20 a minute per address and 300 per site (`limitVisitor`, in `rate_limits`). Members' and visitors' calls are metered against the site's rows a minute; the owner's are never counted. The code's `ctx` (`siteHost`) runs site SQL (`siteSql`, checked by `edge/src/sql.ts`: one statement, only the site's own tables, no pragmas, attaching, triggers, transactions or recursion; at most 100 bound values; no query plan check), reads and sets members' roles (`_naru_roles`), and hashes and checks guests' passwords with PBKDF2-SHA256 (20,000 iterations, PHC strings `$pbkdf2-sha256$i=20000$<salt>$<hash>`, `edge/src/passwords.ts`; ten wrong passwords an hour per key, kept in memory, `checkPassword`); `Math.random` is the host's. `ctx`'s methods return promises, but the object answers each at once and drains the interpreter's job queue before the transaction ends, so an `async` export settles inside it. A throw, a limit, or a failed `ctx` operation (even one the code caught) rolls the whole call back. `ctx.fail(code, message, details)` sends `details` as `error.details` and marks the error `site: true`: its message is the site's own, written for visitors, which SDK 1.1.0 shows as is where it words Naru's other errors in Korean. Empty path segments, `.`/`..`, backslashes and extra colons are rejected.

The mini's workerd (Naru's own build, `edge/seoul/workerd/`, launched with `WORKERD_SQLITE_STATEMENT_TIMEOUT_MS=3000`) stops any one `sqlite3_step` of a statement JavaScript runs that passes 3 seconds, a migration's included; it is what bounds a slow statement, as Naru does not check query plans. workerd runs every site on a shard on one thread, so a statement holds up all of that shard's sites (the mini runs four, `edge/seoul/README.md`, "Shards") until it ends or is stopped. A stopped read throws `SQLITE_INTERRUPT` in the object, which `sqlFailure` (`edge/src/sql.ts`) makes 400 `INVALID_REQUEST` "This statement ran longer than 3 seconds and was stopped; give it an index or read less." (the budget from the object's `SQLITE_STATEMENT_TIMEOUT_MS` binding, `seoul/build.mjs`). A stopped write rolls back SQLite's transaction, which resets the object (its output gate breaks, and the next request meets a fresh one with nothing the call's code wrote); the caller's stub throws instead of answering, and the caller words it (`interruptedCall`): the same 400 for a call (`call` in `edge/src/index.ts`, a visitor's in `website.ts`), 422 `migration_failed` for an activation (not naming the migration, which the reset object cannot tell), and 503 `UNAVAILABLE` for Naru's own statements, which are paged or linear in the site's 100 MiB (a dump's snapshot copies 100 MiB in about 0.3 s on an M4). Cloudflare's runtime and local runs (npm's workerd) have no budget; `control-plane/src/lib/site-data/__tests__/statement-budget.test.ts` runs only with `NARU_WORKERD_BIN` (`scripts/with-edge-worker.sh`).

Each stop holds up every site for 3 seconds, so a statement stopped again and again (one that every page view runs, say) is paused by a circuit breaker (`edge/src/breaker.ts`). A breaker is one statement of one function of one site: `<kind>:<file>:<name>:<statement>`, the statement being the SHA-256 of its text with whitespace collapsed (`*` for the whole function, when the statement is not known). The object reports each stopped statement of site code (`siteSql` in `edge/src/site.ts`, the site's queries, mutations, routes and live queries' runs alike) into `breaker.ts`'s module memory before the stop's error leaves it. The Worker and the object run in the same isolate under workerd (one service on the mini, and in local runs), so what the object leaves there survives the reset a stopped write causes, and the Worker reads it after its stub throws; the stub itself only throws the runtime's own `interrupted: SQLITE_INTERRUPT` (with `durableObjectReset`), whatever the object threw or returned. A reset with nothing reported counts against the whole function. The Worker counts strikes in its own memory, so resets do not erase them (a workerd restart does, which only lets statements run sooner): 3 within 60 seconds pause the breaker for 5 minutes, 30 when it last paused within the hour. Each call and render (`index.ts`) and visitor's call (`website.ts`) passes the site's paused breakers to the object, which keeps the last list it was given for live queries' runs too (and the live connection's upgrade carries it in `X-Naru-Paused`); `siteSql` refuses a matching statement before its `EXPLAIN`, with 503 `UNAVAILABLE`, `details.reason` `statement_paused` and `retryAfter`. A paused whole function is refused in the Worker before the object. Migrations are not breakered: a stopped one refuses its release, which the release task does not retry.

After the strike that pauses it, the Worker records the trip in the site's object with a stub of its own (`recordBreakerTrip`: `_naru_breaker_trips`, the latest 50, with the statement's text up to 2 KB; not in dumps) and adds the site to its unnotified set. Site operations: `breakerTrips` (the record, with `pausedUntil` from the Worker's memory), `clearBreaker` (`{ key? }`: the Worker forgets that breaker, or all of the site's, and the object marks the trips cleared and takes the Worker's remaining list) and `ackBreakerTrips` (`{ ids }`: marked told; the Worker drops the site from its unnotified set once none are left). `POST /v1/breakers/unnotified` lists those sites. A release's activation clears every breaker of the site, in the Worker and in the record. The control plane shows the trips on the database page (`중지된 쿼리`, `/api/account/stopped-queries`, `다시 허용` calling `clearBreaker`), and the `edge-breaker-alerts` job (every minute, `control-plane/src/lib/edge/breakers.ts`) posts each unnotified trip to the operators' Discord, then acknowledges it. A trip whose site the Worker forgot in a restart before the job ran is not posted; it is still on the owner's page. `control-plane/src/lib/site-data/__tests__/statement-breaker.test.ts` checks it end to end with `NARU_WORKERD_BIN`.

Calls share one QuickJS WebAssembly instance per Worker isolate (`edge/src/quickjs.ts`), each in its own runtime and context, freed with all its handles before the call returns. A call that runs out of CPU or memory, fails inside the engine, or does not free cleanly retires the instance, and one is replaced after 1,000 calls regardless. The instance's memory is capped at 32 MiB, and each call has a 128 KiB interpreter stack, a CPU budget of 2,000 interrupt checks (about 70 ms on Cloudflare; Workers stop the clock while code runs, so time cannot be measured) backed by a fuel meter that also counts work in built-ins (`edge/src/engine.ts`), 10,000 promise jobs (async steps too small to reach an interrupt check), at most 100 `ctx` operations (each `ctx.sql` statement, writes included), three password operations, 1,000 URL parses (`URL` is the host's, reached through a counted host call), 2,000 `Math.random()` draws (each a counted host call to `crypto.getRandomValues`, about 3 µs, so not a `ctx` operation), 500,000 rows read by its SQL, and a 1 MiB result; each statement returns at most 1,000 rows and 1 MiB. These are the measurements of `spikes/quickjs-functions/`. Failures are 400 `INVALID_REQUEST` ("Function failed: …"), 404 for a missing module or export, 503 `UNAVAILABLE` while the site has published no code, and the operation's own code for a failed `ctx` operation (`QUOTA_EXCEEDED`, or `CONFLICT` with `details.unique` for a value a `UNIQUE` column already holds).

The site's tables live in the site's SQLite database beside Naru's own (`edge/src/sql.ts`'s `INTERNAL`, and anything named `_naru…`), which site SQL cannot name. `_naru/migrations/*.sql` create them: a release's migrations are sent with `activateFunctions`, and the object refuses a release that edits, removes or names a migration before one already applied (recorded in `_naru_migrations` with its digest), writes a dump of the database to `_naru-runtime/<site>/restore-points/<generation>.ndjson.gz` in the private bucket (`naru-private`, which no public domain serves; docs/deployment.md) when any are pending, then applies them in name order and switches to the release in one transaction; the owner can return the site to a restore point (`restoreFrom`, edge/FUNCTION-IMPORTS.md), keep one now (`saveRestorePoint`, `manual-<ms>.ndjson.gz`: one at a time, three an hour, counted from the names in R2) and download any of them, streamed through the control plane (`GET /api/account/restore-points?download=<name>`). Restore points are gzip-compressed NDJSON (`application/gzip`, no Content-Encoding; their contents for owners: docs/sdk-v1-api.md, "A restore point's file") and are kept for seven days, the owner's own too: the site's object deletes its expired ones whenever it writes a new one, and the daily `restore-point-retention` job does so for every site, deleting nothing outside `restore-points/`. The nightly B2 backup keeps a deleted point as a hidden version for about 30 more days. A refusal is a 422 with `details.reason` `migration_failed`. The tables count toward the site's 100 MiB with its documents (`checkDatabaseSize`), and dumps carry them. A dump is NDJSON (a header with the schema, a line per row, an end line with the count), written from a snapshot a part at a time and restored through staging tables, so neither side holds a whole site (edge/FUNCTION-IMPORTS.md, "Dumps"). Files in earlier formats (`.ndjson`, `.json`) under `restore-points/` are neither listed nor restored, and expire by their upload time.

Routes are the site's opt-in server-rendered pages: `_naru/routes/<path>.js`, whose default export the edge Worker serving the site (`edge/src/pages.ts`) runs through the object's `render` as a visitor's query with `{ path, origin, params, query }` (`origin`: the subdomain or custom domain the page was asked on, for absolute URLs). Activation writes the release's routes to `_naru-runtime/<site>/routes.json` in the private bucket, which the Worker reads (kept 30 seconds per isolate) and matches before the site's files (`control-plane/src/lib/site-functions/routes.ts`: fixed segments before `_param` ones). A route answers HTML, `{ html }`, `{ body, type }` with a text type, `{ file, head }` or `{ redirect }`, with an optional `status` and `cache` of 0–300 seconds in the data center's cache. A site whose paid status has lapsed or is unconfirmed renders nothing: the object refuses with a 404 whose `details.reason` is `routes_off`, and its route paths answer the plain `404 Not Found` of any unknown path. While the mini is away (unreachable, Caddy's 502/503/504, or a 503 from the object) a page's navigation gets the site's `index.html` at 503, below; any other failure is a short error page.

Every finished upload's references are tracked in the site's object (`media_refs`): each document write records which upload IDs its document's JSON names by URL (`/<owner id>/<upload id>`), and the owner's media library asks the object (`mediaReferences`) which of a page of uploads any document names, to mark the rest. The first such question records every existing document's references once (meta `media_refs`). The site's own tables (1.1.0) record nothing as site SQL writes: when the owner opens the library, it asks once (`GET …/_files?references=tables`, `executeMedia`) for every ready upload, and the control plane asks the object (`tableMediaReferences`) with all their IDs (at most 10,000). The object reads each table of `siteObjects()` but full-text ones (and their shadow tables, which `siteObjects` leaves out) 1,000 rows a page by rowid (by offset for a `WITHOUT ROWID` table), only TEXT values (`CASE WHEN typeof(c) = 'text'`), yielding to other requests between pages, and matches any UUID in them against the IDs: a URL, a bare ID, JSON or HTML alike. It answers each found upload's tables and columns (at most ten), and `partial` once it has spent 8 seconds or read 256 Mi characters (`TABLE_SCAN_MS`, `TABLE_SCAN_CHARS`); one scan runs at a time per object, and one meeting it waits for it. Measured under local workerd, 50,000 rows holding 57 M characters (a 124 MiB dump) with 10,000 IDs took 0.45 s, about 8 ms a page, and despite the yields every request to the process waited up to about 0.3–0.4 s meanwhile: the same site's, another site's object, and a path no object answers alike. So the object keeps its last answer in memory (never stored) with the IDs asked and the connection's write count (`total_changes()`), for 60 s (`TABLE_SCAN_WINDOW_MS`): the same question with no write since is answered from it, and any other (other IDs, or after any write) is a 429 `RATE_LIMITED` with `details.retryAfter`, which the library shows as still being checked, with documents' references only. After the minute, a look scans again and sees a deleted row gone. Nothing is deleted on a reference's account, and site code cannot delete uploads. `site_data_files.managed` in PostgreSQL, from an early 1.1.0 upload option, is unused.

### Live queries

`GET /api/data/v1/:site/_live` with `Upgrade: websocket` is answered at the edge (`website.ts`), which hands the connection to the site's object (`SiteData.fetch`) to hold with the WebSocket Hibernation API: idle connections cost nothing, and `"ping"` is answered with `"pong"` without waking the object. A member first `POST`s to the same path with their token; the control plane answers `{ ticket }`, an HMAC over the site, the member and a one-minute expiry, signed with `EDGE_WORKER_SECRET` (`live-ticket.ts`), and `?ticket=` on the upgrade makes the connection that member's. Without one it is a visitor's. Opening counts one request against the site's monthly budget; an object holds at most 1,000 connections, and only while the edge may answer the site's visitors (`configure`).

On the connection the page sends `{ type: "subscribe", id, query, args }` (`query` is `"<module/path>:<export>"` of `_naru/queries/`) and `{ type: "unsubscribe", id }`; the object answers `{ type: "result", id, result }` or `{ type: "error", id, error }`. A subscription's first run is a query call like any other, counted and limited; the object keeps it in `_naru_subscriptions` with the tables its SQL read (`["*"]` if it read a view) and a hash of its answer. When a call's SQL writes a table, the object re-runs, on its next turn, the subscriptions that read it, once for each query, arguments and member that share it (at most 200 a turn), and sends each subscription an answer whose hash changed; activating a release re-runs all of them. Re-runs are tallied as `live_refresh`, not counted against the caller. A connection holds at most 20 subscriptions and a site 5,000. Setting a member's status to anything but approved closes their connections with code 4003 (`disconnect`), after which the SDK does not reconnect.

### What early 1.1.0 left behind

Each site's SQLite keeps three things from the first 1.1.0 design, which had collection rules, site functions under `_naru/functions/`, document secrets and members writing collections: `documents.created_by` (null for every write now, still sent as `createdBy` because 1.0.0 pages receive it), `documents.secret_hash` (unused, still added to new objects so every object's documents have the same columns for dumps), and meta `rules:<id>` entries (cleared when their collection is deleted). A collection still marked with the old `member` read or write level is treated as `admin`. A release manifest that lists `functions/` or `rules/` files no longer validates, so a site whose code was published then must publish it again.

## SDK releases

The SDK is served from `https://sdk.naru.pub`, at these paths, and a site picks one:

- `/sdk/1/naru.js` (and `/sdk/1/naru.d.ts`) is the newest 1.x release. A site that imports it picks up compatible fixes and additions without changing anything. This is what the docs and the example blog use.
- `/sdk/1.0.0/naru.js` is one exact release, for a site that wants the same code on every load. It was frozen on 2026-10-12 and never changes (see [sdk-1.0.0-release.md](sdk-1.0.0-release.md)).
- `/sdk/1.1.0/naru.js` adds members, the site's own code and live queries. **1.1.0 remains under active development and will continue to be updated until the project owner says otherwise**; once frozen it never changes, and fixes ship as 1.1.1 and so on.

Each version is written in TypeScript at `control-plane/sdk/<version>/naru.ts`; `pnpm sdk:build` emits the served `naru.js` and `naru.d.ts` beside each other under `public/sdk/<version>/`, and those emitted files are committed (1.1.0 also serves `functions.d.ts`, the types of queries', mutations' and routes' `ctx`, written by hand there; `tests/naru-functions-1.1.0.types.ts` checks it), so a deploy serves exactly what was reviewed. `pnpm build` refuses to proceed while they are stale. `/sdk/1/` is an alias in `control-plane/sdk/aliases.json`; point it at the newest 1.x directory when one ships, and release naru-sdk. Only `sdk.naru.pub/sdk/*` serves them: workerd on the mini (`edge/src/sdk.ts`, the committed files bundled into `edge/seoul/`), with `Cache-Control: public, max-age=300, stale-while-revalidate=86400`, so a browser keeps a file a day and picks up a fix within minutes. The control plane serves none of it, in production or development: `naru.pub/sdk/*` is a plain 404 (`control-plane/src/proxy.ts`). Unversioned SDK URLs are not served. A change that would break a 1.x caller goes into `/sdk/2/`.

The wire protocol is versioned separately, in the path: `/api/data/v1/:site` and `/api/data-auth/v1/*`. Every 1.x SDK file that was ever served keeps calling these, including copies cached or bundled by sites, so they stay compatible for as long as 1.x is supported: routes, parameters, response shapes and error codes. Breaking server changes need `/api/data/v2/` alongside v1.

The 1.0.0 SDK is deliberately small. Its runtime exports are only `createNaru` and `NaruError`. A client has `collection()` and `auth`; a collection has `get()`, `list()`, `count()`, `pages()` and `add()` (plus `set()` and `delete()` for an admin); an admin client has `collection()`, `batch()`, `media.upload()` and `signOut()`. Media listing and deletion remain in the control panel. Features are added when a site needs them, not in advance.

1.1.0 keeps 1.0.0's collections as they are and adds what a community site needed: `naru.members` with `session()` and `signIn()`; `query()`, `mutate()` and `subscribe()` on the client, a member and (but `subscribe()`) the owner, for the site's own code; a member client with `id`, `media.upload()`, `media.delete()` and `signOut()`; upload IDs and `media.delete()` for the owner with an explicit grant; and errors worded in Korean for visitors. It also finishes only the sign-in whose `state` this tab sent, leaving any other `?code=` on the page alone, and returns to the address a sign-in left from.

During 1.0.0 development the SDK dropped `createDatabase`, per-collection `parse`/`map`, `schemas`, `update` merge patches and `unset`, `count()`, `all()`, string `orderBy` with `direction`, `fresh`, `timeoutMs`, `createRequestChannel`, session events, application schema parsing and response validation, upload progress, image tuning options, and the file `get`, `update` and `usage` methods. The server removed the obsolete public endpoints and options. The SDK still validates JSON values and uses private transport parameters for cache bypass.

## Internal HTTP protocol

This is the v1 wire format the SDK speaks. Applications use the SDK, not these
routes, but released SDK files depend on them, so the website root below is a
compatibility surface: change it only compatibly. Query parameters and response
fields use the SDK's own names, so the SDK passes them through; the server turns
private numeric versions into opaque revisions.

Website root: `/api/data/v1/:site`. Control-plane root: `/api/account/database` (site derived from the session; ships with the server and is not versioned). Collection management is restricted to the control-plane root. Collection names starting with `_` are reserved for the protocol's own paths (`_batch`, `_files`, `_query`, `_mutate`, `_live`) and cannot be created.

| Method | Path relative to root                    | Body / result                                                     |
| ------ | ---------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/`                                      | Admin only: `{ collections }`                                     |
| POST   | `/`                                      | Admin only: `{ name, read?, write? }` creates collection          |
| PATCH  | `/:collection`                           | Control panel only: `{ read, write }` replaces permissions        |
| DELETE | `/:collection`                           | Admin only: deletes collection and its documents                  |
| GET    | `/:collection?size=50&after=cursor`      | `{ documents, nextCursor, totalCount? }`; accepts sort and filter |
| POST   | `/:collection`                           | `{ data }` creates document; returns the write result             |
| GET    | `/:collection/:id`                       | `{ document }`                                                    |
| PUT    | `/:collection/:id?ifRevision=&ifAbsent=` | `{ data }` replaces document; returns the write result            |
| DELETE | `/:collection/:id?ifRevision=`           | `{ success: true }`                                               |
| POST   | `/_batch`                                | Admin-only atomic set/delete `{ operations }`                     |
| POST   | `/_query/<module/path>:<export>`         | Runs a query `{ args }`; returns `{ result }`                     |
| POST   | `/_mutate/<module/path>:<export>`        | Runs a mutation `{ args }`; returns `{ result }`                  |
| POST   | `/_live`                                 | Member only: `{ ticket }` for a live connection                   |
| GET    | `/_live` (WebSocket upgrade)             | Live queries; `?ticket=` for a member's                           |
| GET    | `/_files?size=50&after=`                 | Control panel only: `{ files, nextCursor }`, newest first         |
| GET    | `/_files?usage=1`                        | Control panel only: `{ usage }`                                   |
| POST   | `/_files`                                | Admin-only upload authorization                                   |
| PUT    | `/_files/:id`                            | Admin-only finalize; verifies the stored bytes                    |
| DELETE | `/_files/:id`                            | Control panel only: `{ success: true }`                           |

A response to an owner request that renewed its token carries `Naru-Owner-Expires`, the new expiry as epoch milliseconds, and `Naru-Owner-Expires-In`, the same expiry as whole seconds from now, both exposed to the page through CORS. The SDK adds the duration to its own clock, so a device whose clock is wrong neither signs out early nor keeps a session past its end; the instant stays for SDK files that already read it. Both are additive, so an SDK that ignores them simply holds an expiry no later than the true one. A public write result is `{ id, data, revision, createdAt, updatedAt, createdBy }`; `createdBy`, from an early 1.1.0 in which members wrote documents, is null for every write now, and stays because 1.0.0 pages receive it (they ignore it). A delete, alone or batched, refuses an absence condition. `_batch` takes `set` and `delete` operations only (a server-assigned id is `add`'s, outside transactions) and answers `{ success: true, results }`: in operation order, `{ id, revision, createdAt, updatedAt }` for a set and `null` for a delete, never the data. A website token may only authorize and finalize uploads; the media library is listed and deleted from the control panel. A private `fresh=1` query flag forces a non-cacheable read; it is not an SDK option. A list accepts `filter` and `sort` (URL-encoded JSON, exactly as passed to the SDK), `size`, `after` and `includeTotal=1`. An upload authorization takes `{ name, contentType, size }` and returns `{ id, uploadUrl, headers }`: PUT the bytes to `uploadUrl` with those headers, then finalize with `PUT /_files/:id`. The SDK returns a file's `{ url, name, contentType, size }`; the control panel's library reads `{ id, name, contentType, size, url, createdAt, updatedAt }`. The public route does not accept `PATCH`.

All JSON request bodies require `Content-Type: application/json`. Website errors return `{ error: { code, message } }`, where `code` is one of the v1 codes in the [SDK reference](sdk-v1-api.md#errors-and-cancellation); the server sets it, and the HTTP status is diagnostic. A `DataError` names its code only where the status alone would be wrong (a failed condition and a full quota are both 409, for instance); otherwise 401, 403, 404, 429 and 5xx map to `AUTH_REQUIRED`, `ACCESS_DENIED`, `NOT_FOUND`, `RATE_LIMITED` and `UNAVAILABLE`, and any other status to `INVALID_REQUEST`. The v1 code list is closed: a new code needs a new protocol version, and the SDK reads a code it does not know by its status. The control-plane root keeps `{ error }` with a plain message. Public preflight needs no authentication. Errors, writes, and authenticated reads are not cached; anonymous reads from `world`-readable collections may use the short shared cache described below.

Administrator authorization endpoints:

| Endpoint                               | Purpose                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /database/authorize`              | Login/consent UI; never issues a code on GET.                                                                                 |
| `POST /api/data-auth/authorize`        | Same-origin owner approval with `site`, `redirectUri`, `challenge`, `state`, `collections`; returns validated redirect URL.   |
| `POST /api/data-auth/v1/token`         | Exchange JSON `{ code, verifier, redirectUri }` from the registered Origin; returns `{ accessToken, expiresIn, expiresAt }`.  |
| `POST /api/data-auth/v1/revoke`        | Revoke the bearer token supplied in Authorization; requires its registered Origin.                                            |
| `GET /members/sign-in`                 | Member sign-in page (SDK 1.1.0): `site`, `redirectUri`, `challenge`, `state`; never issues a code on GET.                     |
| `POST /api/data-auth/member-authorize` | Same-origin member approval with the same fields; returns the redirect URL with `code` and `state`.                           |
| `POST /api/data-auth/v1/member-token`  | Exchange `{ code, verifier, redirectUri }` from the page's Origin; returns `{ accessToken, expiresIn, expiresAt, memberId }`. |
| `POST /api/data-auth/v1/member-revoke` | Revoke the member bearer token supplied in Authorization; requires its Origin.                                                |

There is no discovery request. A `clientId` sent by an SDK copy from before it was dropped, in the consent query or the token exchange, is ignored: the code is bound to one registration, and consent looks the registration up by the signed-in owner, `site` and callback page. The `v1/` endpoints are what websites call and answer with the coded error body. `POST /api/data-auth/authorize` is the consent screen's own same-origin call. Released SDKs also fix the consent page's query (`site`, `redirectUri`, `challenge`, `state`, `collections`) and the `code`, `state` and `error` it returns to the callback, so those change only compatibly too.
| `GET/POST /api/account/database-clients` | Same-origin owner registration listing/creation (`{ redirectUri, collections }`). |
| `PATCH/DELETE /api/account/database-clients` | Same-origin owner revoke-all/remove registration (`{ id }`). |

There are at most 20 registrations per site, 20 pending codes and 50 live tokens per registration. Expired grants are cleaned during authorization activity. Removing registrations/accounts/sessions cascades into their grants.

## Limits and consistency

- 100 collections, 100,000 documents, and 100 MiB of serialized JSON per site, separate from the hosted-file quota.
- Maximum request body: 64 KiB, including the `{ data }` envelope; enforced while streaming, even without Content-Length.
- Collection names and document IDs: 1–64 ASCII letters, numbers, underscores or hyphens.
- Pages: 1–100 documents (default 50), defaulting to ID ascending in byte order. See sorting below; pagination is not a snapshot across concurrent changes.
- Documents use JSON values with JavaScript number precision and no significant object key order. Application-visible ordering is defined by Naru, not by database collation.
- Each site's Durable Object serializes document and collection operations in synchronous SQLite transactions, including permission and quota checks. Deletes free quota; account deletion erases the site's object. Media operations retain their PostgreSQL transaction path.
- A site holds at most 10,000 media files: the byte quota alone does not bound row count, since the smallest accepted file is one byte.
- Each individual replacement or delete is atomic. `admin.batch()` makes its ID-addressed sets and deletes one atomic server transaction. Writes are last-write-wins when no condition is supplied; `condition.revision` rejects stale writes and `condition.absent` guards creation. There is no offline persistence. Collections have per-collection unique fields: up to three top-level fields (`unique: ["nick"]` in a collection's PATCH, or the control panel) whose string or number values no two documents may share. Every write path refuses a duplicate with 409 `CONFLICT` and `details: { unique: field }`, and setting them is refused while documents already share a value. Each is backed by a partial expression index for its collection.

## File uploads (SDK 1.0.0)

Admin sessions can upload files directly to the `naru-media` R2 bucket. The SDK
obtains a ten-minute signed upload URL, sends the bytes directly to R2, and asks
Naru to verify the stored size and content type before returning a ready file.
Database documents should store `file.url`, not base64 data.

```js
const image = await admin.media.upload(fileInput.files[0], {
  signal: abortController.signal,
});
await admin.collection("posts").set("hello", {
  title: "Hello",
  coverImage: image.url,
});
```

A page that uses a file stores its URL. SDK 1.0.0 exposes upload only. SDK
1.1.0 also returns a media ID and supports `media.delete(id)`: members delete
their own uploads, and owner website sessions need explicit deletion consent.
See [media deletion](media-deletion.md) for cleanup, quota and retry behavior.
Naru records which documents name each upload's URL and the media library
marks those none does, but it never deletes one on that account; the app or
owner must request deletion.

사이트 소유자는 **미디어 라이브러리**(`/media`)에서 파일을 끌어
놓아 업로드하고, 저장 공간을 확인하고, 이름·형식으로 검색하거나 정렬하고, 공개
URL을 복사하고, 파일을 삭제할 수 있습니다. 삭제 전에 해당 URL을 사용하는 문서를
직접 확인해야 합니다.

Uploads use the same bearer token as document writes: an owner's, or from SDK
1.1.0 a member's, limited per member (see [Site members](#site-members-sdk-110)). Each file is limited to 25 MiB; each site is limited to 250
MiB. JPEG, PNG, WebP, AVIF, GIF, supported audio, PDF, ZIP, and
plain text are accepted. HTML and SVG are rejected. Public objects are served
from the separately isolated `media.naru.pub` origin. Deleting a file removes
the R2 object and queues durable metadata cleanup (see [SDK 1.1.0 deletion](media-deletion.md)); deleting an account removes its media
prefix. Upload authorizations that are not finalized, including ones whose
transfer failed, are removed by the background cleanup after one hour.

Bytes go from the browser straight to R2 on a signed URL, so the browser is the
only place a photo can be made smaller before it is stored. The current implementation (not a frozen SDK guarantee) shrinks a
JPEG, PNG, WebP or HEIC image before asking for an authorization when its long
edge exceeds 2048 px or it is larger than 512 KiB: it draws it at most 2048 px
on the long edge and encodes WebP at quality 0.82, or JPEG on a white background
where the browser cannot encode WebP. The declared size is the shrunk size, so
quota and the 25 MiB limit count what is stored. The original is kept when
re-encoding would not make it smaller; HEIC is always converted, since it is not
an accepted type, which is how an iPhone photo uploads from Safari. Where the
browser cannot decode HEIC (Chrome, Firefox), the SDK throws `TypeError` before
asking for an authorization; a file named `.heic`/`.heif` with an empty type
counts as HEIC. Every other type is left to the server's allowlist. Re-encoding
drops EXIF and bakes orientation into the pixels. Files retained unchanged may
still contain metadata; upload is not a metadata-removal guarantee. The stored name takes the new extension. There are no
image options; the media library at `/media` uploads originals and does not resize.

Upload progress comes from the one step that has bytes to count, the PUT to R2.
`fetch` exposes no upload progress, and streaming its body to count it would
send no `Content-Length`, which a presigned PUT requires, so when a caller
passes `onProgress` the SDK sends that same PUT with `XMLHttpRequest` (as the
`/media` library does); without it, the SDK uses `fetch` as before. The request
is the same, headers and CORS preflight included, so the bucket's existing CORS
rule covers it. `XMLHttpRequest` cannot refuse a redirect, so a response whose
`responseURL` is not the signed URL is treated as a failed upload.

Public access permits callers from any origin. Anonymous writes into `create` or `world` collections use fixed-minute limits of 60 successful writes per site and 20 per caller/IP per site. Each site's Durable Object stores and checks these counters in the write transaction. Owner writes do not count, and failed writes roll back their counters. Queries and mutations have their own limits ([Site code](#site-code)).

The Worker reads the visitor IP from Cloudflare’s trusted header. Requests forwarded through the control plane share an `unknown` bucket (20/minute/site) unless trusted IP forwarding is enabled. Set `TRUST_CLOUDFLARE_IP=1` **only** when a trusted ingress replaces `CF-Connecting-IP` and direct access to the application is blocked. Otherwise clients can spoof the header to evade IP limits. Production satisfies this requirement: naru.pub is DNS-only, straight to Caddy on the mini (infra `apps/naru-sdk/Caddyfile`), which replaces `X-Forwarded-For` and `CF-Connecting-IP` with the address it saw; the gateway (infra `apps/naru/nginx/default.conf`) trusts `X-Forwarded-For` only from private peers (Caddy, on the host), takes the visitor from it, and overwrites `CF-Connecting-IP` before proxying to the application. The router forwards only 443, to Caddy, so nothing on the internet reaches the gateway directly. Toss's `BILLING_DELETED` sender check reads the same header. With the setting enabled, valid IPs get separate buckets while invalid/missing headers still share `unknown`. Only a digest is stored in the bucket key; it is not guaranteed anonymization. The object removes expired buckets during anonymous-write admission.

`cleanup-site-data-grants` periodically removes expired authorization codes and access tokens, owners' and members', from PostgreSQL. It does not touch the object’s rate-limit buckets.

These limits do not protect reads, invalid requests or authorization endpoints from high request volumes. The gateway's nginx config sets per-client limits for `/api/data/*` (30 r/s, burst 60) and `/api/data-auth/*` (2 r/s, burst 10) with matching body caps, keyed on the visitor address Caddy passes on in `X-Forwarded-For`. PostgreSQL backups cover authentication and media metadata, not the documents stored in Durable Objects. The existing hosted-file export does not include site database documents.

### Reads and caching

Anonymous document reads normally reach only the Worker and its Durable Object.
Requests requiring the control plane use PostgreSQL for admission and
credentials, with statement deadlines, a bounded pool (`DATABASE_POOL_MAX`,
default 20), and a checkout timeout. Document operations run in the object's
SQLite transaction, independently of the PostgreSQL pool.

A read of a `world`-readable collection that carries no credential returns the
same bytes to everyone, so it is served with
`Cache-Control: public, max-age=0, s-maxage=10` and the SDK lets the browser and
any shared cache honour it. Anything carrying a credential, every write, and
every error stays `no-store`, so an intermediary that ignores `Vary` can never
replay one caller's authorized response to somebody else.

The SDK remembers every collection this loaded module writes, including writes
whose response was lost. Its subsequent reads of those collections carry the
private `fresh=1` transport flag and request `no-store`. The server answers
these reads with `no-store` too; caches never store this separate query variant.
This lasts until the module is reloaded and is independent of the server's
cache lifetime. Unwritten collections continue to benefit from shared caching.
Other browsers can see public writes after the shared cache expires.

That window is also the lag on a permission change: changing a collection from
`world` to `admin` stops new reads immediately, but a shared cache may keep
answering an already-cached public read for up to ten seconds, and nothing in
the control plane can purge it. The data was public until that moment, so this
delays hiding it rather than exposing anything new — but treat "make it admin"
as taking effect within seconds, not instantly.

## Tests

```sh
cd control-plane
pnpm exec tsc --noEmit
pnpm exec jest --config jest.data.config.cjs --runInBand
node --test tests/naru-data-sdk.test.mjs
```

Integration tests require an empty database named exactly `naru_data_test`. They cover all permission combinations, create-only restrictions, rate/quota races, PKCE, single-use codes, token scope, expiry, renewal and its bounds, revocation, domain validation and session/registration deletion. HTTP tests cover cookie isolation, same-origin admin protection, authentication and preflight; SDK tests cover CRUD transport and errors. The dedicated Jest config avoids obsolete global Lucia and Request mocks in the existing test setup.

The full database suite starts a scratch PostgreSQL cluster for accounts and
authentication and a local Worker under `wrangler dev`. Install dependencies
in both `control-plane/` and `edge/` first:

```sh
cd control-plane
pnpm test:data:db
```

## Where site data lives

Each site's collections and documents are one SQLite database, held by a
`SiteData` object (`edge/src/site.ts`) named by the site. Since 2026-10-15
those objects run on kr-seongsu-m4, the mini, under workerd: the same edge
Worker code as on Cloudflare (`edge/src/seoul.ts`, `edge/seoul/`), with each
site's database a file under `~/apps/naru-sdk/site-objects`. Its R2 bucket
is reached through the S3 API (`edge/src/r2-s3.ts`), and there is no edge
cache: a visitor's read is a local query.

- `https://sdk.naru.pub` is the data API, the SDK files and live connections.
  It is a DNS-only record for the mini's home line; the router forwards 443
  to Caddy there (infra `apps/naru-sdk`), which sets the visitor's address in
  `CF-Connecting-IP` and `X-Forwarded-For` for the rate limits. The Worker
  answers visitors itself and sends requests with a sign-in to the control
  plane on the same host (`PASSTHROUGH_ORIGIN`).
- `sdk.naru.pub/sdk/<version>/naru.js` is the SDK, from the same workerd:
  browsers keep it for a day, checking after five minutes. 1.1.0 sends data
  requests to `sdk.naru.pub`; sign-in and saved sessions stay on naru.pub.
  `naru.pub/sdk/` serves nothing (404).
- The control plane calls site objects at `SITE_DATA_URL`
  (`http://host.docker.internal:40100` from its containers) with
  `SITE_DATA_SECRET`, which also signs members' live tickets. Pageviews and
  the custom domain table stay with the Worker on Cloudflare
  (`EDGE_WORKER_URL`, `EDGE_WORKER_SECRET`).
- `naru.pub/api/data/v1`, which 1.0.0 still calls, is the control plane's
  own: naru.pub is DNS-only, straight to Caddy on the mini, and the control
  plane calls the site's object there. The edge Worker on Cloudflare serves
  neither the SDK nor a data API.

PostgreSQL retains accounts, entitlements, website registrations,
authorization codes and tokens, and media metadata. Media bytes remain in R2.
The object uses the shared validation, filter and cursor modules and serializes
operations in synchronous SQLite transactions. Public-write rate limits are
counted in the object. Timestamps have millisecond precision, collection names
are listed in byte order, and JSON object key order has no contract meaning.

### When the mini is away

The mini holds the only copy of each site's database; there is no standby
(nightly backups, below, are what recovers it). While it is away:

- Hosted sites' static files are still served from R2 by the edge Worker on
  Cloudflare. The SDK itself is on the mini: a browser that loaded it within
  the last day uses its cached copy; others cannot import it.
- Data calls fail: `sdk.naru.pub` does not answer, nor does the control
  plane on the same host, and the SDK rejects each call with `UNAVAILABLE`
  as it does any other failure. Nothing serves site data meanwhile.
- A route path (`_naru/routes/`) cannot be rendered, so a page's navigation
  to one gets the site's own `index.html` with status 503 (`Cache-Control:
  no-store`, `Retry-After: 60`), for the app's shell to load and say so.
  Other requests to a route path, and sites without `index.html`, are
  answered as if the site had no routes (`edge/src/pages.ts`). This is only
  for the mini being away: a site whose paid status has lapsed answers its
  route paths 404 whether the mini is up or not, from the object's own
  refusal (`routes_off`), told apart from a proxy's error because it must
  arrive as the object's JSON at that same status.
- The edge Worker's cron runs the `Standby` object each minute
  (`edge/src/standby.ts`, named for the standby it once was). It probes two
  hosts at once, each with its own count of failed minutes:
  `https://origin.sdk.naru.pub/healthz/deep`, the mini's own name (workerd
  and a site database), and `https://naru.pub/api/health`
  (`CONTROL_PLANE_HEALTH_URL`), the control plane through Caddy and the
  nginx gateway, which is up only when it answers 200 with
  `{"status":"ok"}` as JSON (a 502, a redirect or a gateway's own page is
  down). Each posts to Discord, naming its host, when it has failed three
  minutes in a row, and again when it answers, so one host's outage neither
  hides nor repeats the other's. It only alerts: nothing changes over. The same object forwards
  route renders to the mini, since Cloudflare's Los Angeles location could
  not connect to the home line directly in a drill.

### Backups

The nightly `backup-postgres-r2.zsh` on the mini copies each site database
with `sqlite3 .backup` into the backup set in B2. The Cloudflare copies from
before the move are archived in B2 under `cutover/`.

A site's whole database still goes between objects as a dump (`dump` and
`restore`, which refuses a site that has collections or tables;
`control-plane/src/lib/edge/dumps.ts`), for tests and `edge/seoul/smoke.mjs`.
`SITE_DATA_MAINTENANCE=1` makes the control plane refuse every data request,
for a future move between hosts.

### Answering visitors at the edge

`edge/src/website.ts`, on the mini at `sdk.naru.pub`, answers anonymous
document requests, visitors' queries and
mutations, and live connections from that site's object using shared headers
and errors. It forwards requests with owner or member tokens, `_files`, `_batch`, and requests the object cannot
serve to the control plane. That fallback still uses the same Durable Object
for documents; PostgreSQL handles authentication and media metadata.

The object serves visitors only while its database entitlement is valid and
its confirmation is current. Otherwise it sends the request to the control
plane, which checks PostgreSQL: the edge never refuses on paid status, so a
lapsed site is refused on time and a renewed one is served at once, without
waiting for the next sync. The `edge-sync` job runs every five
minutes, sends the entitlement end date and a three-day confirmation, and
copies document count and bytes used to `users` for admin reporting. It
includes active complimentary accounts, subscriptions that expired within the
last 60 days, and every site holding documents, so a refund or a removed
complimentary plan reaches the edge within minutes. Expired confirmations
defer to the control plane's entitlement check, so sites keep answering
visitors through a control-plane outage of up to three days. The job does not
create routes or copy documents.

Public reads may be cached at the edge for ten seconds. `fresh=1` reads are
never cached. The zone's cache rule does not apply to Worker responses.

### Monthly request budget

Each site answers at most 5,000,000 anonymous and member requests per calendar
month (UTC) by default. Owner requests and requests answered from the edge
cache do not count. After the budget is spent, visitors receive 429 `RATE_LIMITED` until
the next month. `SITE_MONTHLY_REQUESTS` sets the default; `monthlyRequests`
in `configure` overrides it for a site. Counts are persisted every 25 requests,
so an evicted object can forget up to 24 requests. Each month's requests are also counted by
kind, with the rows SQLite read for them (meta `stats:<YYYY-MM>`: `visitor_read`,
`visitor_write`, `visitor_query`, `member_query`, `visitor_call` and
`member_call` for mutations, `live`, `live_refresh`, `rows`; earlier months
may hold kinds since removed), saved
with the budget and shown in the owner's listing as `usage.requests.kinds`, so
the budget can be sized from what sites do.

Three guards keep one caller, or one site, from spending what others need
(`site.ts`):

- Reads a minute: 600 per address for visitors' reads and queries, and per
  member for their queries (`limitReader`, kept in memory; `SITE_READS_PER_MINUTE`
  changes it, as naru-dev does, where every local browser is one address). Every per-address limit,
  this one and the visitors' write and call buckets, keys an IPv6 address by
  its /64 (`addresses.ts`), so stepping through one subscriber's addresses
  earns no fresh limit.
- Work a minute: the rows SQLite reads for a site's members and visitors,
  counted from each query's `rowsRead` (`metered`), at most 5,000,000 a minute
  (`SITE_ROWS_PER_MINUTE`, or `rowsPerMinute` in `configure` for one site).
  Past it the site refuses its members and visitors with 429 `RATE_LIMITED`
  until the next minute, never its owner. A site shares its workerd
  shard's one thread with the other sites hashed to it (edge/seoul/README.md,
  "Shards"), so a site whose queries scan slows itself rather than the others.
- The owner's /database shows the month's requests against the budget
  (`usage.requests` in the owner's collection listing), marked from 80%.

A write's quota check reads the site's document count and bytes from a
`usage` row that triggers on `documents` keep, rather than counting every
document.

Collection creation outside a document request, such as website registration
or board-template application, commits in the object separately from the
PostgreSQL transaction. Template applications record the application first;
failed collection creation is reported as skipped.

## Public guide and example

The Korean guides are served publicly at `/docs` (index), `/docs/database` and `/docs/media`. The control panel links to it without adding a global header link.

## Server-side sorting and pagination (SDK 1.0.0)

```js
const naru = createNaru();
const posts = naru.collection("posts");
const query = {
  sort: [
    ["publishedOn", "desc"],
    [{ metadata: "createdAt" }, "desc"],
  ],
  size: 20,
};
const first = await posts.list({ ...query, includeTotal: true });
const next = await posts.list({ ...query, after: first.nextCursor });
```

`sort` is always a list of one or two `[field, direction]` pairs. User fields are named directly; metadata uses `{ metadata: "id" | "createdAt" | "updatedAt" }`, and the ID may only be the sole key. `direction` is `asc` or `desc`. The document ID is appended automatically as the final tie-breaker. Without `sort`, a list reads in ID order.

Metadata timestamp ties use document ID in the last direction. IDs use ASCII
order. User fields sort ascending as missing/null/non-scalars, strings, numbers,
then booleans (false before true). Strings use Unicode code-point order without
locale rules or normalization; numbers compare numerically. Descending reverses
the order. Arrays and objects tie with null and missing fields. The SQL builds
these keys explicitly rather than relying on database-native JSON ordering.
The explicit-document-ordering migration sets ID collation to C and rebuilds
the existing primary and metadata indexes. It holds a table lock while doing so;
allow a maintenance window for large installations. Its rollback restores the
database default collation without changing document data.
Metadata orders have composite collection/time/ID indexes; JSON-field sorting
scans the narrowed collection and has no per-field index.

`get`, `add`, `set`, and the documents in `list` return `data`, `createdAt`, and `updatedAt`. Server metadata is camelCase throughout the API; the underlying columns stay snake_case. Creation time is assigned by the server, preserved on replacement, and cannot be changed by fields in `data`. The migration backfills existing documents from their recorded modification time; their original creation time is unknown.

Pass `nextCursor` unchanged as `after` with the same collection, ordering, and filters. Cursors are opaque, query-bound continuation state: applications must not inspect or construct them. The SDK and server may change their representation. They are not credentials; read permissions are checked on every request. Changing page size is allowed.

A null cursor marks the end, and passing `null` as `after` reads the first page. Cache prior pages or their starting cursors for a Previous button. There are no page numbers or offsets. `includeTotal: true` returns `totalCount`; for only the number, use `size: 1`. Reset the cursor and displayed results when switching sort order or filters. Pagination is not a snapshot across requests: newly inserted records before the cursor require a refresh; changing a sort value during traversal can skip or repeat a record.

Cancel a superseded read with a standard `AbortController`, passing its `signal`; the request then rejects with the browser's own `AbortError`.

## Equality and range filters with automatic indexes

```js
const page = await naru.collection("posts").list({
  filter: {
    category: "일상",
    date: { gte: "2026-09-01", lt: "2026-10-01" },
  },
  sort: [["date", "desc"]],
  size: 20,
});
```

HTTP: `GET /api/data/v1/:site/:collection?filter=<URL-encoded JSON object>&sort=<URL-encoded [["date","desc"]]>`. The account API accepts the same parameters. Media lists refuse a `filter`. Conditions address top-level fields and are ANDed. An equality value is a JSON string, finite number, boolean, or null. A range value is an object containing one or more of `gt`, `gte`, `lt`, and `lte`, whose bounds must be finite numbers or strings. Each equality or range bound counts as one predicate, with at most 5 predicates in total. Field names use the same 1–64 ASCII alphanumeric/underscore/hyphen rules as document IDs. The decoded filter JSON is limited to 2,048 UTF-8 bytes. Absent `filter` and `{}` mean no filtering.

Equality types match exactly: number 1 differs from string "1"; null matches an explicit null field, not an absent field. Strings match case-sensitively. Arrays and objects cannot be equality values. Range comparisons operate only within the bound's JSON type, so a string bound never selects numeric fields and vice versa; multiple bounds for one field must use the same type. Store sortable dates in a fixed-width representation such as ISO `YYYY-MM-DD`. Missing fields do not match ranges. Nested paths, array membership, OR, and substring search are not supported. Filters are carried in URLs; do not put secrets in them.

SQLite indexes support collection/ID and collection/time ordering. Document-field filters and sorting use SQLite JSON expressions within the selected collection. Apart from the fields a collection's `indexes` name (see [Declared collections](#declared-collections)), field sorting and filtering may scan that collection.

Opaque cursors include a SHA-256 fingerprint of normalized filters. Reordering equivalent keys works; changing, adding or dropping a filter invalidates the cursor. Read permissions and admin scopes are checked on each page. Filters are not authorization: publicly readable collections remain readable without filters.

## Extended blog example

Create `posts` (world/admin), `guestbook` (world/create), and **`drafts` (admin/admin)**. Register the callback with `posts` and `drafts`. Edit the existing callback in the control plane to include both collections; its grants are revoked immediately. No Client ID is needed; site and registered page URL identify the page.

The public list filters by exact `category`. The editor loads paginated posts/drafts, edits documents while preserving other JSON fields, saves private drafts, publishes, and deletes the selected document after confirmation. Local tab storage preserves the editor through the login redirect; explicit server draft saving persists across sessions. Signing out clears the editor and local draft.

Draft and public copies share an ID. Saving a private draft does not unpublish or change an existing public post. Publication uses `admin.batch()` to write the post and remove its draft atomically; failure preserves the draft and leaves the public post unchanged. Deletion affects only the selected collection. An editor returns the opaque revision it read as `condition.revision` to detect a concurrent change and receive `CONFLICT` instead of overwriting it. Guestbook moderation remains in the control panel.

### Website identity and admin tokens

Sign-in identifies the site and registered page URL. Each registered page retains its callback and collection IDs. Changing a callback URL or its collection permissions revokes all of its codes and access tokens, including when widening scope. Reducing its token lifetime also revokes them. Increasing only the lifetime preserves existing tokens with their original deadlines; pending codes retain the duration already approved. Saving an unchanged registration does not revoke access. Removing a callback cascades the same revocation.

Every `/api/data-auth/v1/token` exchange returns `{ accessToken, expiresIn, expiresAt }`; the token is sent as `Authorization: Bearer <accessToken>`. `expiresIn` is the lifetime in whole seconds, which the SDK measures on the browser's clock; `expiresAt` is the same expiry in Unix milliseconds on the server's clock, kept for SDK files that read it. Accepted owner requests renew the idle window within the hard bounds described under authentication above; the `Naru-Owner-Expires-In` response header on a renewal keeps the SDK current. `POST /api/data-auth/v1/revoke` takes the bearer token and revokes it idempotently. The unpublished renewal tables and `/refresh` and `/end-session` endpoints have been removed; the existing access-token table is sufficient. Requests use explicit credentials and never ambient cookies.

### Configuring token lifetime

In the control plane, create or edit a registered admin page and set its token lifetime in minutes (1-1440, default 1440). The account registration API accepts `tokenLifetimeSeconds` as a whole-minute integer in seconds, from 60 through 86400. Existing registrations and outstanding codes migrate with a default of 86400; existing token deadlines are preserved. `PATCH /api/account/database-clients` can update only `{id, tokenLifetimeSeconds}`. Omitting this field preserves the current lifetime. Other users and website bearer tokens cannot change it. Database constraints enforce the range as well as application validation.

Consent displays the configured duration and submits that displayed value. Approval binds the smaller of the current registration limit and the displayed duration to the one-use code; exchange cannot widen it with an SDK argument or a concurrent settings increase. Shortening a registration revokes pending codes as well as issued tokens. Rollback revokes outstanding grants before returning to the old fixed-lifetime behavior.

### SDK 1.0.0 data and error contract

`collection<Post>("posts")` and `admin.collection<Post>("posts")` type reads,
lists and complete replacement writes. Types describe the application's
schema; the SDK checks JSON values but does not validate application fields at runtime.

Only JSON values are accepted: null, booleans, strings, finite numbers, dense
arrays, and plain objects. Undefined, functions, symbols, bigint, dates, class
instances, accessors, sparse arrays, and cycles throw `TypeError` before sending.
Convert dates to strings explicitly. `set()` replaces the entire document;
there is no merge. `get`, `add`, and `set` return the same document shape,
including the stored data. A create-only visitor receives its own saved data,
without gaining access to any previous or other document.
Each successful document write returns an opaque `revision`. Pass a previously
read revision as `condition.revision` to `set()` or `delete()` to reject a stale write
with `code: "CONFLICT"`; `condition: { absent: true }` asserts that the document does not
exist; it applies to `set()` only. Applications must not parse or construct revisions.

A failed operation throws `NaruError` with a stable semantic `code` such as
`CONFLICT`, `QUOTA_EXCEEDED`, `AUTH_REQUIRED`, `RATE_LIMITED`, or `UNAVAILABLE`. HTTP status and
the original cause are diagnostic only. Network and invalid proxy responses are
normalized to `UNAVAILABLE`; cancellation remains the browser's `AbortError`. A
collection name or ID outside 1–64 ASCII letters, digits, underscores and
hyphens throws `TypeError` before any request. Other invalid input is the
server's to refuse with a 400.

There are no automatic retries. A failed or interrupted response does not prove
that a write failed: retrying `add()` can create another document. Read back or
reconcile before retrying. Cursor pagination is not a snapshot: concurrent edits
can move records between pages, especially when sorting by `updatedAt`.
