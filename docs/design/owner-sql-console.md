# Owner SQL console and row edits (데이터베이스 → 테이블)

Status: option A built (2026-10-18, `ownerQuery`); B and C are proposals.

The 테이블 tab (85c25223) browses a site's 1.1.0 tables read only, a page of
100 rows at a time (`tableRows`, edge/src/table-rows.ts). Owners have asked
for two more things: running their own SQL, and changing rows. This note
weighs both and proposes an order.

## What already exists to build on

- `classify` (edge/src/sql.ts) sorts one statement into `read`, `write` or
  `schema` and refuses everything else: PRAGMA, ATTACH, temporary tables,
  virtual tables other than fts5, and Naru's own tables (`reserved`). It
  already lets SQL read `_naru_member_roles` and `_naru_uploads` but never
  write them.
- `siteSql` (edge/src/site.ts) runs one site statement with limits: 64 KiB of
  text, at most `MAX_ROWS` (1,000) rows and 1 MiB of JSON returned, and
  `MAX_ROWS_READ` (500,000) rows read per call. On the mini, workerd also
  stops any single step that runs past `SQLITE_STATEMENT_TIMEOUT_MS`. It also
  records which tables a statement read or wrote, so live queries refresh
  (`scheduleRefresh`).
- Restore points: `saveRestorePoint` keeps one of the present, one at a time
  and at most 3 an hour; `restoreFrom` returns to one, and keeps the present
  first.
- The owner route pattern: same origin plus `validateRequest`, plus the
  `database` feature (site-tables-http.ts, restore-points-http.ts).

## Option A: read-only SQL console (recommended first)

A textarea and a 실행 button on the 테이블 tab. Results show in the same
grid, using the same cell shaping (long text cut, BLOBs as their size).

- **Edge (as built):** `ownerQuery({ text })`. It parses one statement with
  `statements`, runs `classify(tokens, ["read"])`, and runs it as
  `SELECT * FROM (<statement>) LIMIT 1001`. No write parses as a subquery, so
  nothing can change even if `classify` let a write through. Bound values
  aren't taken.
- **Limits (as built):** 64 KiB of text; at most 1,000 rows and about 1 MiB
  of shaped JSON returned, with `more` when rows were left out. The step
  budget stops a long read. `MAX_ROWS_READ` isn't applied: it is checked
  after a statement finishes, which saves nothing for a read. These statements stay out of the
  site's breakers (breaker.ts): an owner's slow query shouldn't pause the
  site's own statements, and the step budget already bounds each one. The
  console doesn't count toward visitors' rows-per-minute either.
- **Throttle (as built):** 30 statements a minute per site object, kept in
  memory, refused as 429 with `Retry-After`.
- **Risk:** low. It only reads, `classify` already guards site SQL, and the
  object is the site's own. The worst case is one slow read, which the step
  budget stops.
- **Cost:** about one edge operation, one route, one panel, and tests at the
  three levels the browser has. Roughly the size of the 테이블 commit.

## Option B: row edits in the grid

Edit a cell, insert a row, or delete a row from the browser.

Things that make this harder than it looks:

1. **Writes skip the site's rules.** A site's mutations check roles, keep
   invariants (counters, denormalized columns, timestamps) and write related
   rows together. An edit from the panel skips all of that. That's
   acceptable for the owner, but the UI has to say so.
2. **Identifying a row.** Rowid tables can use `rowid`. `WITHOUT ROWID`
   tables need their primary key columns (`pragma_table_info.pk`). Tables
   whose columns shadow `rowid`, `_rowid_` and `oid` have no usable rowid:
   refuse edits there or use the primary key. fts5 tables: edit through the
   content table only.
3. **Concurrent changes.** A visitor's mutation can change the row between
   the page load and the save. A write should be conditional
   (`UPDATE … WHERE rowid = ? AND <every shown column IS its shown value>`)
   and refuse with "the row changed, reload" when it matches 0 rows.
4. **Types.** SQLite stores whatever is given. The grid needs per-cell
   choices for NULL, number, text, and leaving a BLOB unchanged (BLOBs can't
   be edited). Cut-off long text has to load its full value before editing,
   or be read-only.
5. **Side effects the object already handles for site writes:** the database
   size quota (`checkDatabaseSize`), live-query refresh (`scheduleRefresh`
   for the written table), and upload references, which are scanned on
   demand so nothing extra is needed.
6. **Undo.** Before a session's first write, save a restore point
   automatically. A manual-style point would use up the 3-an-hour limit, so
   give it its own name and kind (`before-edit-<ms>`, kept the usual 7 days,
   at most one per 10 minutes) and list it in 복원 지점 as "편집 직전".

The cost is about 2–3 times option A, mostly UI (an editable grid, type
controls, conflict messages) and the restore-point kind.

## Option C: a SQL console that writes

Option A with `classify(tokens, ["read", "write"])`.

- Everything from B's points 1, 5 and 6 applies. Points 2–4 don't, because
  the owner writes the statement.
- A write the step budget stops on the mini resets the whole object, which
  briefly affects visitors too. A site's own mutations carry the same risk
  today, but an owner trying `UPDATE big_table SET …` is the likely way to
  hit it.
- One statement per run, no transactions across runs, and a confirm dialog
  showing what the statement will change ("이 문장은 posts 테이블을
  바꿉니다").
- Cheaper than B, since it needs no editable grid, but it's only for owners
  comfortable with SQL.

## Schema changes: keep refusing

`CREATE`, `ALTER` and `DROP` stay out of the console in every option (the
"schema changes belong in _naru/migrations/" refusal). A table changed by
hand drifts from the migrations. The next release's migrations would then
run against a schema they weren't written for, naru-dev's
`_naru/types/database.d.ts` would be wrong, and a restore point couldn't
tell the two apart. The only supported way to start over stays
데이터베이스 초기화.

## Proposal

1. Build **A** now: it's low risk, and it's what most "how do I look at my
   data" questions need (filters, joins, counts).
2. Then **C** (writes in the console, behind a confirm dialog and an
   automatic `before-edit` restore point) if owners ask to fix data by hand.
3. Build **B** (editable grid) only if non-SQL owners need to edit, and
   reuse C's restore-point and quota plumbing.

## Open questions for the owner

- Ship A alone first, or A and C together?
- Should console statements be logged anywhere the owner can see later, or
  is nothing kept (as for 테이블 browsing today) fine?
- Rate limit: is 30 statements a minute per site right?
