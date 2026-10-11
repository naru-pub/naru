# Spike: site functions on QuickJS inside the site's Durable Object

Question: can a site owner's `functions.js` run inside `SiteData`, synchronously
within `transactionSync`, cheaply and safely? Answer: yes, with three
non-obvious requirements (below). Local `wrangler dev` only (workerd on an
Apple Silicon Mac); nothing was deployed.

- `src/index.ts`: a Worker and a `Site` Durable Object (simplified `documents`
  table) that runs `quickjs-emscripten-core` 0.32.0 with the
  `@jitl/quickjs-ng-wasmfile-release-sync` variant.
- `fixtures/functions.js`: owner functions (`buy`, `gacha`, `appraise`) plus
  hostile ones.
- `check.mjs`: correctness, sandbox and timing checks against a running
  `pnpm exec wrangler dev --port 8799`. `measure.mjs`: production timings.
  Both send `SPIKE_TOKEN` from the environment.

## Design that passed

- One host entry point, `__host(op, json)`; a guest prelude wraps it as a frozen
  `ctx` (`get`, `list`, `add`, `set`, `delete`, `random`, `now`, `member`).
  JSON strings cross the boundary, nothing else.
- Each call: new wasm instance → runtime → context → eval `functions.js` → run
  the export inside `transactionSync`. A guest throw, interrupt, out-of-memory
  or stack overflow throws out of the transaction, which rolls back.
- The instance is dropped, never freed (see 3).

## Results

| Check | Result |
|---|---|
| `buy`: balance, stock, inventory | correct; sold-out and insufficient funds return values |
| write then throw | rolled back (wallet and stock unchanged) |
| write then infinite loop | interrupted, rolled back, object keeps serving |
| guest globals | ECMAScript built-ins only: no `fetch`, `require`, `process`, `std`, `os`, `WebAssembly`, `setTimeout` |
| state between calls | none (fresh instance per call) |
| async function | refused: "Functions are synchronous" |
| bundle | 266 KiB gzip (wasm 247 KiB); today's edge Worker is 17 KiB gzip |
| cold first call | ~9 ms (instantiate 1, context 2, eval source 5, call 1) |
| warm per call, fresh instance | probe 0.7 ms, `buy` (6 host ops) 0.6–0.8 ms, `gacha` over 300 rows 1.6 ms, `appraise` over 1,000 rows 3.4 ms |
| same, instance reused | `buy` 0.08 ms: instance setup is ~0.5–0.7 ms of each call |
| 10,000 fresh-instance calls | workerd RSS 185 → peak 200 MB; old instances are collected |

## Three requirements the spike found

1. **The CPU limit can't use the clock.** Workers freeze `Date.now()` and
   `performance.now()` while code runs, so `shouldInterruptAfterDeadline` would
   never fire in production. Count interrupt-handler calls instead: QuickJS-ng
   calls it about every 5,000 loop iterations, and a budget of 2,000 checks
   stopped `for(;;){}` after ~44 ms locally. A tight but heavier loop body runs
   longer per check (10M iterations of `x = (x + i) | 0` took 338 ms for the same
   2,000 checks), so calibrate on production CPUs and keep a platform CPU limit
   (`limits.cpu_ms`) as a backstop.
2. **`setMemoryLimit` does not work in this build.** It refuses single
   allocations over the limit but does not count most allocations: 100 MB of
   strings, arrays or typed arrays went through an 8 MiB limit, and an
   unbounded loop grew to ~2 GB, taking 4–8 s to fail. Cap the wasm memory
   itself instead: the module imports its memory, so pass
   `new WebAssembly.Memory({ initial: 256, maximum: 512 })` (16 MiB minimum,
   32 MiB cap). Every memory bomb then fails as a catchable "out of memory" in
   ~50 ms. Without the cap a site could push the isolate past its 128 MB limit
   and reset objects of other sites sharing that isolate.
3. **The QuickJS stack limit must sit below the host stack.** With
   `setMaxStackSize(512 KiB)` deep recursion overflowed *V8's* stack mid-wasm.
   That leaves the QuickJS heap inconsistent, and `JS_FreeRuntime` then aborts
   the whole instance (`Assertion failed: list_empty(&rt->gc_obj_list)`). The
   local boundary is between 320 and 384 KiB; 256 KiB gives ~1,600 frames and a
   clean, catchable `RangeError`. The real host headroom in production is
   unknown, so also treat any host exception from wasm as fatal to that
   instance. A fresh instance per call that is dropped (never freed) makes that
   automatic.

## Production (Workers Paid, deployed 2026-10-12, then deleted)

`measure.mjs` times one Worker→DO RPC that makes n calls, minus an empty RPC
(9–16 ms), because the object's own clock does not move.

| Measure | Production | Local |
|---|---|---|
| Worker startup | 2 ms | — |
| `Date.now()` advance inside the DO during a call | 0 (frozen) | advances |
| per call, fresh instance: probe / `buy` / `gacha` / `appraise` | 4.6 / 4.2 / 8.0 / 13.2 ms | 0.7 / 0.8 / 1.6 / 3.4 ms |
| per call, instance reused: probe / `buy` | 0.24 / 0.61 ms | 0.05 / 0.08 ms |
| interrupt budget of 2,000 checks (`spin`) | ~70 ms | ~44 ms |
| memory bombs with the 32 MiB cap | out of memory in ~150 ms | ~50 ms |
| deepest safe `setMaxStackSize` | 256 KiB passes, 320 KiB overflows the host | 320 KiB passes |
| one `set` from the guest | ~0.13 ms (overwrite) to ~0.19 ms (insert) | — |
| `writeForever` (host calls in a loop) | **killed after ~37 s (error 1101)**: 5,000 writes cost only 5 interrupt checks | — |

Changes this forces:

- **Host calls must count against the budget.** The interrupt handler only
  runs between bytecodes, so time spent in `ctx.*` is free to the guest. Cap
  host operations per call (for example 200, of which at most 20 writes), and
  set a platform CPU limit below the 30 s default.
- **Lower the stack to 128 KiB.** 256 KiB is one step below where production
  overflows.
- A fresh instance costs ~4 ms here. Cheap in money (see below), but if latency
  matters, reuse one instance per object and discard it after any failure.

Rows written per document write, measured with `cursor.rowsWritten`: 1 to
overwrite, 2 to insert, in this spike's schema (primary key only). The real
`documents` table has two more indexes, so plan for ~4.
- Wiring into the real `SiteData`: collection ids and permissions, the v1
  `storable`/`encode` checks (the spike stored `undefined` as `null`), quotas,
  error mapping to `NaruError` codes, member identity from a token.
- Loading `functions.js` from the site bucket through edge-sync, and caching it
  compiled (bytecode) instead of re-evaluating each call (~0.5 ms with a small
  file).
- `Math.random` in the guest is QuickJS's own, not crypto-grade: replace it with
  a `ctx.random`-backed one, or remove it. `eval` and `Function` exist inside
  the sandbox; harmless, but they could be removed through context intrinsics.
