# Site code: modules, imports and releases

A site's code (SDK 1.1.0) lives in five folders under `_naru/`:

- `queries/<path>.js`: exports that read, called as `query("<path>:<export>")`;
- `mutations/<path>.js`: exports that write, called as `mutate("<path>:<export>")`;
- `routes/<path>.js`: server-rendered pages, each answering the path it is
  named for with its default export (`control-plane/src/lib/site-functions/routes.ts`);
- `modules/<path>.js`: shared code, which cannot be called or routed to;
- `migrations/<name>.sql`: SQL that creates and changes the site's tables,
  directly in the folder.

For example:

```js
// _naru/modules/prices.js
export const price = 10;
// _naru/mutations/shop/buy.js
import { price } from "../../modules/prices.js";
export async function buy(ctx) {
  return price;
}
```

Call `member.mutate("shop/buy:buy")` (or the visitor's or owner's
`mutate()`). Static relative imports and re-exports, including cycles, are
supported. Include the extension, `.js` or `.mjs`; one name may not have both.
Paths stay inside these four code folders, and any of them may import any
other. Package names, URL imports, dynamic imports and top-level await are
rejected. No filesystem, network, Node APIs or package installer are exposed
to the interpreter. Transpile TypeScript before uploading; bundling
JavaScript is unnecessary.

## Releases

Each file operation affecting these five folders publishes a snapshot of them
and nothing else (`publishSiteFunctions`, from `cache-purge.ts`); template
installation and GitHub deployment publish once after all their files are
ready. Upload dependencies before entry points when uploading individual
files. Failed publication leaves the previous release active and the edited
working files available for correction. A site with no release gets one on
its first call, published by the control plane (`withRevision`). Changes made
directly to R2 must explicitly invoke the control-plane publisher; ordinary
calls do not revalidate mutable files.

The control plane creates snapshots (`control-plane/src/lib/site-functions/revisions.ts`)
and records releases in PostgreSQL's `site_function_releases` table.
Publication and an Absurd `function-release-v1` task commit together
(`releases.ts`). The control plane sends an authenticated `activateFunctions`
RPC to the site's Durable Object, with the release's migrations; the object
stores the active revision and release generation in its SQLite meta. Older
task retries cannot replace a newer generation. The durable task retries
activation if the inline RPC fails. After activation the control plane writes
the active release's routes to `_naru-runtime/<site>/routes.json`, which the
edge Worker reads to serve them (`edge/src/pages.ts`).

R2 holds a complete copy of each release under
`_naru-runtime/<site>/revisions/<revision>/`: the files of `queries/`,
`mutations/`, `routes/`, `modules/` and `migrations/`, and `manifest.json`
(version 2), which maps each file's path to the SHA-256 of its source and
holds nothing else. Every publication gets a new revision, including
unchanged releases; sources are never shared between revision directories.
The manifest is written last, after all source uploads succeed, and is
verified with its sources on cold reads. A manifest that lists any other path,
such as the `functions/` and `rules/` folders of an early 1.1.0, no longer
validates: such a site's code must be published again.

Activation changes only the pointer after validation and storage finish.
Each call pins its revision and loads its complete module graph before
entering the synchronous SQLite transaction; QuickJS imports then resolve
exclusively from that graph. Read-only queries and routes, rollback, CPU,
memory and host-operation limits apply equally to imported code.

## Migrations

`_naru/migrations/<name>.sql` (names of `[A-Za-z0-9_.-]`, at most 128
characters) ride in the same snapshot, recorded in the manifest beside the
modules. The control plane sends a release's migrations with
`activateFunctions`; the object refuses a release that edits, removes or
names a migration before one already applied (recorded in `_naru_migrations`
with its digest), writes a dump of the database to
`_naru-runtime/<site>/restore-points/<generation>.ndjson.gz` when any are pending,
then applies them in name order and switches the pointer in one transaction.
A migration's statements may create, alter and drop tables, indexes and views
and write rows; each passes the checks of `ctx.sql` (`edge/src/sql.ts`), and a
write the plan check as well (`checkPlan`, `edge/src/plan.ts`). The plan check
holds a statement to one rule: its cost grows at most linearly with table
sizes. Each `EXPLAIN QUERY PLAN` step gets a degree: 0 for a `SEARCH` by `=`
on every column it uses (row ID, primary key or any index), `SCAN CONSTANT
ROW` and `VALUES`, `json_each`/`json_tree` (`VIRTUAL TABLE INDEX 1:` or `3:`)
and an fts5 table by rowid (an index string with `=`); 1 for a `SCAN`, a
`SEARCH` by a range or with no constraint, an fts5 table read whole or by
`MATCH`/`LIKE`/`GLOB`, and an `IN (SELECT ...)` list that drives the `=`
search before it (a `LIST SUBQUERY` without `CREATE BLOOM FILTER`, or `USING
... FOR IN-OPERATOR`). Sibling loops add their degrees; a `CORRELATED`
subquery adds its degree to all its group's loops; `MATERIALIZE`, plain
`SCALAR`/`LIST SUBQUERY`, an `AUTOMATIC ... INDEX` and a `BLOOM FILTER ON`
cost theirs once, and reading a materialized result costs what made it; a
`CO-ROUTINE` is costed where it is read, inside the loops before it;
`MULTI-INDEX OR`, compound parts and `RIGHT-JOIN` cost the most of theirs;
`USE TEMP B-TREE` costs nothing more. Everything inside a correlated subquery
counts once per outer row. A path over 1 is refused, naming the loop that
multiplies; a step of any other shape is refused naming the step. Known gap:
`=` on a non-unique index counts as 0, so a self-join on a shared value can be
near quadratic on skewed data; `MAX_ROWS_READ` is the backstop, counted from
the cursor's `rowsRead` after each statement finishes, so it fails the call
but never stops a statement part way. Estimating fan-out from
`sqlite_stat1` (`ANALYZE`) would close the gap; it is not done.
`src/plan.test.ts` measures `src/plan.corpus.ts` in workerd at N and 4N rows
(how to add a statement is at the top of the corpus); the user-facing limits
and patterns are in `docs/sdk-v1-api.md`, **SQL limits**. A refusal is a 422 with `details.reason`
`migration_failed`; the release task then deletes the refused revision and
its row instead of retrying, and leaves the active release.

### Restore points

`_naru-runtime/<site>/restore-points/` holds `<generation>.ndjson.gz`, kept
before a release's migrations, `before-restore-<ms>.ndjson.gz`, kept
before a restore, and `manual-<ms>.ndjson.gz`, kept when the owner asks
(names: `control-plane/src/lib/site-functions/restore-points.ts`).
Each is a dump (below), gzip-compressed: the NDJSON writer is piped through
`CompressionStream("gzip")` (`gzip`, `edge/src/dump.ts`) and the compressed
bytes packed into the multipart parts, stored as `application/gzip` with no
Content-Encoding, so nothing on the way decompresses it; a restore reads it
through `DecompressionStream` (`gunzip`), and a file that is not whole gzip is
refused before anything changes. A whole site's `dump` and `restore`
stay uncompressed. Files in earlier formats (`.ndjson`, `.json`)
are not restore points: they are neither listed nor restored, and expire by
their upload time. The owner lists and restores them on the control panel
(`/api/account/restore-points`, `lib/site-functions/restore.ts`), which calls
the object's `restoreFrom({ name })`; index.ts sets `site` from the URL, so an
object only reads its own site's prefix. Under `blockConcurrencyWhile`, the
object reads the restore point into staging tables, so one that is not a
whole dump is refused before anything is kept or changed; dumps the present
to `before-restore-<ms>.ndjson.gz`; then in one transaction empties and refills
DUMP_TABLES and the site's tables, migrations and roles from the staging
tables, and re-runs every live query. What describes the
present stays: the meta keys of the owner, paid status and limits, the
month's budget and counts (flushed from memory first), and the active release (`functions_revision` and
`functions_generation`, which `site_function_releases` names; a release's
restore point holds the release before it, whose files are deleted five
minutes after), and `rate_limits`. The rest of meta (`unique:`, `indexes:`,
`media_refs`) is the restore point's. Migrations of the active release that
the restore point had not applied are pending again and apply with the next
release. The control plane then writes `routes.json` for the active release
again; nothing cached is purged, as releases purge nothing.

The owner keeps one now with POST `{ create: true }`, which calls the
object's `saveRestorePoint` (index.ts sets `site` from the URL): under
`exclusive`, as any dump, it writes `manual-<ms>.ndjson.gz` and prunes. One is
written at a time per object (a second meanwhile is a 409 `CONFLICT`), and
at most `MANUAL_RESTORE_POINTS_PER_HOUR` (3) an hour, counted from the
`manual-` names in R2, so nothing else is stored (then 429 `RATE_LIMITED`).
GET `?download=<name>` streams a point from the bucket through the control
plane (`openRestorePoint`, never read whole) as `application/gzip` with
`Content-Disposition: attachment; filename="<site>-<name>"`, for the signed-in
owner's own site only.

Restore points are kept for seven days (`RESTORE_POINT_DAYS`): a point's age
is the time in its name (a UUIDv7's milliseconds, `before-restore-<ms>` or
`manual-<ms>`: the owner's are kept no longer than the others),
or, for a name that is not a restore point's, when it was uploaded.
`pruneRestorePoints` deletes the expired ones under a site's
`restore-points/`, and nothing outside it, in batches of 50: the site's object
runs it after writing each new point, and the control plane's daily
`restore-point-retention` job (`cli/prune-restore-points.ts`) for every site
in the bucket. The nightly backup to B2 keeps what is deleted as a hidden
version for about 30 more days (infra `kr-seongsu-m4/bin/backup-postgres-r2.zsh`).

### Dumps

A dump (`control-plane/src/lib/site-data/dump-format.ts`) is NDJSON, one JSON
value per line:

```
{"type":"header","version":2,"schema":["CREATE TABLE …", …]}
{"type":"row","table":"meta","row":{…}}            Naru's tables, by name
{"type":"row","table":"site:posts","row":{…}}       the site's own tables
{"type":"row","table":"_naru_migrations","row":{…}}
{"type":"row","table":"_naru_roles","row":{…}}
{"type":"end","rows":<how many row lines>}
```

A BLOB is `{ "$base64": … }`; a full-text table's rows carry `rowid`, and its
own storage tables are left out. A dump without its end line, or with the
wrong count there, is refused. The object writes one (`openDump`, `dump.ts`)
by copying every table it carries into `_naru_snap_<n>` in one synchronous
transaction, the snapshot, which held the object about 30 ms for a 28 MiB
site under local workerd in tests; it then reads them a keyset page at a time, with
ordinary awaits between pages, into 5 MiB parts of an R2 multipart upload (one
put when smaller; aborted on failure) or the `dump` response, and drops them,
however the dump ends (a reader that leaves a dump unread for five minutes
gives it up). Writes during the dump land after the snapshot and are not in
it. A restore (`stage`) reads lines as they arrive into `_naru_stage_<n>`
(columns `c0`, `c1`… for the rows' keys) a batch to a short transaction, then
swaps them in in one transaction (`swapIn`): Naru's tables emptied, the site's
objects dropped, the schema created again (checked as a migration's is), every
table filled by `INSERT … SELECT` with column names from the object's own
schema, unique and field indexes made again, and the staging tables dropped.
`_naru…` names are reserved from site SQL and left out of dumps and
listings; the site's quota leaves out what snapshot and staging tables take.
One dump or restore runs at a time per object, and each first drops what a
crash may have left of these tables.

## Limits and cleanup

Each graph allows 64 modules and 1 MiB of source; each file allows 256 KiB. A
revision allows 256 files and 4 MiB. Each Worker isolate keeps up to 64
manifests and 32 MiB (2,048 entries) of sources in memory, shared by its
sites' objects and named by their hashes, so sites cannot see each other's;
eviction, restart and new source hashes still read from R2. QuickJS runtimes
are fresh per call.

After activation, the Absurd task waits five minutes and deletes the previous
release's entire directory through the control plane's S3 client, then
removes its release row. There are no edge cleanup endpoints, alarms, reader
leases or cross-revision source references. Temporary deletion failures retry
without acknowledging completion, including partial S3 deletion failures.
Sleeping and completed steps survive worker restarts. Unfinished tasks remain
durable.

Rapid releases briefly retain several revisions; once tasks finish, only the
latest release remains. This intentionally allows a call still loading an old
revision after the grace period to fail; retrying uses the active revision.
Imports load before the database transaction, so missing imports do not
leave partial writes. A rollback must publish a new revision and generation,
and cannot undo an applied migration: what has run is history, and a fix is
a new migration, or the data returned to a restore point (above).
