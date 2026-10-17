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
`_naru-runtime/<site>/restore-points/<generation>.json` when any are pending,
then applies them in name order and switches the pointer in one transaction.
A migration's statements may create, alter and drop tables, indexes and views
and write rows; each passes the checks of `ctx.sql` (`edge/src/sql.ts`), and a
write the plan check as well. A refusal is a 422 with `details.reason`
`migration_failed`; the release task then deletes the refused revision and
its row instead of retrying, and leaves the active release.

### Restore points

`_naru-runtime/<site>/restore-points/` holds `<generation>.json`, kept before
a release's migrations, and `before-restore-<ms>.json`, kept before a restore
(names: `control-plane/src/lib/site-functions/restore-points.ts`). The owner
lists and restores them on the control panel (`/api/account/restore-points`,
`lib/site-functions/restore.ts`), which calls the object's `restoreFrom({ name
})`; index.ts sets `site` from the URL, so an object only reads its own
site's prefix. Under `blockConcurrencyWhile`, the object dumps the present to
`before-restore-<ms>.json`, then in one transaction empties and refills
DUMP_TABLES and the site's tables, migrations and roles from the restore
point, as `replace` does, and re-runs every live query. What describes the
present stays: the meta keys of the owner, paid status and limits, the
month's budget and counts (flushed from memory first), the standby's
fingerprint and the active release (`functions_revision` and
`functions_generation`, which `site_function_releases` names; a release's
restore point holds the release before it, whose files are deleted five
minutes after), and `rate_limits`. The rest of meta (`unique:`, `indexes:`,
`media_refs`) is the restore point's. Migrations of the active release that
the restore point had not applied are pending again and apply with the next
release. The control plane then writes `routes.json` for the active release
again; nothing cached is purged, as releases purge nothing. The standby takes
the restored site at its next sync. A restore point is read and parsed whole,
as large as the site's dump.

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
