# Naru's workerd

The mini (kr-seongsu-m4) serves the Data SDK and every site's database with
workerd (`../README.md`). npm's workerd has no limit on how long a SQLite
statement runs: Cloudflare enforces one in production, standalone workerd
does not. It also runs every site's object on one thread, so a single slow
statement holds up every site until it ends. Naru does not check a
statement's query plan before it runs, so this budget is what bounds a slow
one, migrations' schema statements (`CREATE TABLE ... AS SELECT`,
`CREATE INDEX`) included.

So the mini runs workerd built from the same release npm ships (the
`workerd` version in `edge/package.json`) with one patch,
`sqlite-timeout.patch`, to `src/workerd/util/sqlite.c++`.

## What the patch does

`WORKERD_SQLITE_STATEMENT_TIMEOUT_MS` (read once, at the first database
opened; unset or 0: off, and the binary behaves as npm's) is a wall-clock
budget for each `sqlite3_step` of a statement that JavaScript runs
(`ctx.storage.sql.exec`, its cursor's steps, and `exec`'s earlier
statements). workerd's own statements (its regulator marked TRUSTED: the
key-value table, alarms, metadata) are never budgeted. It installs a SQLite
progress handler, called every 1,000 virtual machine instructions, that
interrupts the step once the deadline has passed.

- **A read** throws `Error: interrupted: SQLITE_INTERRUPT` where it ran. The
  Durable Object lives on; a `transactionSync` around it rolls back as for any
  throw.
- **A write** (`INSERT`, `UPDATE`, `DELETE`, or DDL) that is interrupted makes
  SQLite roll back the whole transaction, which workerd cannot recover from:
  the object's output gate breaks with the same error, the caller's stub
  throws it, and the next request gets a fresh object. Nothing the object
  wrote since its last committed output survives.
- The budget is per step: a statement that hands back rows quickly is never
  stopped, however many it returns.

Naru's edge code turns both into its own errors (`src/sql.ts`,
`interrupted`, `sqlFailure`, `interruptedCall`; `docs/database.md`, "Site
code"). The launch agent sets the budget to 3000 (`~/Git/infra`,
`apps/naru-sdk/launchd/pub.naru.sdk-shard-<i>.plist`, each shard's), and `seoul/build.mjs`
passes the same variable to the Worker as `SQLITE_STATEMENT_TIMEOUT_MS`, for
saying how long a stopped statement ran.

## Building

On an Apple silicon Mac (both Macs run macOS 27 on arm64; the binary's
minimum is macOS 13.5, so CI's macos-15 runs it too):

```bash
node seoul/workerd/build.mjs            # from edge/
node seoul/workerd/build.mjs --revision 2 --record
```

It reads the workerd version from `edge/package.json` (checked against the
lockfile), shallow-clones `cloudflare/workerd` at tag `v<version>` into the
cache (`NARU_WORKERD_CACHE`, default `~/Library/Caches/naru-workerd`),
applies the patch (and stops if it does not apply), downloads bazelisk into
the cache if it is missing (its sha256 pinned in `build.mjs`), and builds
`//src/workerd/server:workerd` with

```
--config=release_macos
--@rules_rust//:extra_rustc_flag=-Cstrip=none
--@rules_rust//:extra_exec_rustc_flag=-Cstrip=none
```

`release_macos` is workerd's own release configuration. The two `-Cstrip=none`
flags are for macOS 27, whose dyld refuses to load the stripped Rust
proc-macro dylibs the build otherwise makes and runs, so the build fails part
way without them. The first build takes about 25 minutes on an M4 and fills
about 6.5 GB of cache; after a patch change, a few minutes.

The result is `<cache>/out/workerd-<version>-naru.<n>-darwin-arm64` and its
`.sha256`, checked with `selftest.mjs` (below). `<n>` is the patch's
revision for that workerd version: `binary.json`'s when it names the same
version, else 1; pass `--revision` when the patch changes. `--record` writes
the build into `binary.json`.

## Publishing

`binary.json` names the build the mini runs: its workerd `version`, the
patch `revision`, the release `tag` (`workerd-v<version>-naru.<n>`) of
naru-pub/naru it is published under, the `asset` name and its `sha256`. The
binary is published by hand, as a GitHub release of this repository:

```bash
gh release create workerd-v1.20261006.1-naru.1 \
  --repo naru-pub/naru --target main --latest=false \
  --title "workerd 1.20261006.1, naru.1" \
  --notes "workerd v1.20261006.1 with edge/seoul/workerd/sqlite-timeout.patch, for the mini (darwin-arm64)." \
  ~/Library/Caches/naru-workerd/out/workerd-1.20261006.1-naru.1-darwin-arm64 \
  ~/Library/Caches/naru-workerd/out/workerd-1.20261006.1-naru.1-darwin-arm64.sha256
```

Publish before pushing a `binary.json` that names it: CI's build-sdk-seoul
job (`.github/workflows/main.yml`) downloads the asset with the job's token,
fails when it is missing, its sha256 is not `binary.json`'s, or
`binary.json`'s version is not `package.json`'s, runs `selftest.mjs` and the
seoul smoke test on it with the 3-second budget, and packs it into the
release tarball as `workerd`. A release's asset is never replaced: a new
build is a new revision.

## Upgrading workerd

When `edge/package.json`'s `workerd` changes:

1. `node seoul/workerd/build.mjs --record` (the revision starts again at 1).
   If the patch does not apply, port it to the new
   `src/workerd/util/sqlite.c++` in the cache's clone (`git -C
<cache>/workerd-v<version> diff > seoul/workerd/sqlite-timeout.patch`
   once it builds): the patch touches the includes, adds `stepBudget` and
   `StepDeadlineScope` beside `disposeSqlite`, scopes the deadline around
   `exec`'s immediate statements and `Query`'s `sqlite3_step`, and installs
   the progress handler in `SqliteDatabase::setupSecurity`, where workerd
   notes that Cloudflare's own limit is set.
2. Publish it (above), then push `binary.json` with the version bump.

## Checking a binary

```bash
node seoul/workerd/selftest.mjs <workerd> [budget ms]
```

serves a tiny SQLite object and checks that, at the budget (500 ms by
default), a slow read throws `SQLITE_INTERRUPT` and keeps the object, a slow
write resets it and leaves nothing, and a fast statement is untouched. npm's
workerd fails it (the slow statement times the check out). The site-code
paths are checked end to end, with the 3-second budget, by

```bash
cd ../control-plane
NARU_WORKERD_BIN=<workerd> LC_ALL=en_US.UTF-8 \
  bash scripts/test-data-sdk.sh src/lib/site-data/__tests__/statement-budget.test.ts
```

which runs `wrangler dev` on the given binary (miniflare's
`MINIFLARE_WORKERD_PATH`) and is skipped without `NARU_WORKERD_BIN`.
