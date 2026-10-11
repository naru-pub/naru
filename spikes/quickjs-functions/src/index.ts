// Spike: site functions run by QuickJS (wasm) inside the site's Durable
// Object, synchronously within transactionSync. Not production code.
import { DurableObject } from "cloudflare:workers";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import baseVariant from "@jitl/quickjs-ng-wasmfile-release-sync";
import wasmModule from "../node_modules/@jitl/quickjs-ng-wasmfile-release-sync/dist/emscripten-module.wasm";

/** 64 KiB pages. The module needs at least 256 (16 MiB); the cap is enforced
 * by the engine, since QuickJS-ng's own limit does not count most allocations
 * under Emscripten. */
const WASM_PAGES = { initial: 256, maximum: 512 };
const newModule = (maximum = WASM_PAGES.maximum) =>
  newQuickJSWASMModuleFromVariant(
    newVariant(baseVariant, {
      wasmModule,
      wasmMemory: () =>
        Promise.resolve(new WebAssembly.Memory({ initial: WASM_PAGES.initial, maximum })),
    }),
  );
let quickjs: Promise<QuickJSWASMModule> | undefined;

let stackOverride: number | undefined;
let wasmMaxOverride: number | undefined;
const MEMORY_LIMIT = 8 * 1024 * 1024;
/** Below the host stack: a host overflow mid-call corrupts the QuickJS heap. */
const STACK_LIMIT = 256 * 1024;
/** The interrupt handler is called about every 10k bytecode ops in QuickJS-ng. */
const DEFAULT_INTERRUPT_BUDGET = 2_000;

// Guest-side wrapper: one host entry point, JSON across the boundary.
const PRELUDE = `
const __call = (op, ...args) => {
  const out = __host(op, JSON.stringify(args));
  return out === undefined ? undefined : JSON.parse(out);
};
globalThis.__ctx = (member) => Object.freeze({
  member: Object.freeze({ id: member }),
  now: __call("now"),
  get: (collection, id) => __call("get", collection, id),
  list: (collection, filter) => __call("list", collection, filter ?? null),
  add: (collection, data) => __call("add", collection, data),
  set: (collection, id, data) => __call("set", collection, id, data),
  delete: (collection, id) => __call("delete", collection, id),
  random: () => __call("random"),
});
globalThis.__run = (name, member, args) => {
  const fn = globalThis.__exports[name];
  if (typeof fn !== "function") throw new TypeError("No function " + name);
  const result = fn(__ctx(member), JSON.parse(args));
  if (result && typeof result.then === "function")
    throw new TypeError("Functions are synchronous; do not return a promise.");
  return JSON.stringify(result ?? null);
};
`;

type Row = Record<string, SqlStorageValue>;
type Timings = Record<string, number>;

class GuestError extends Error {}

export class Site extends DurableObject<Env> {
  private sql: SqlStorage;
  private source: string | null = null;
  private cached?: { context: QuickJSContext; exports: QuickJSHandle; state: { checks: number; budget: number } };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (
        collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (collection, id));
    `);
    this.source =
      (this.sql.exec("SELECT value FROM meta WHERE key = 'source'").toArray()[0]
        ?.value as string | undefined) ?? null;
  }

  deploy(source: string) {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('source', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      source,
    );
    this.source = source;
    this.cached?.context.dispose();
    this.cached = undefined;
    return { ok: true };
  }

  seed(collection: string, documents: unknown[]) {
    const count = documents.length;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM documents WHERE collection = ?", collection);
      for (let i = 0; i < count; i++)
        this.sql.exec(
          "INSERT INTO documents (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          collection,
          `${collection}-${i}`,
          JSON.stringify(documents[i]),
          Date.now(),
          Date.now(),
        );
    });
    return { ok: true, count };
  }

  dump(collection: string) {
    return this.sql
      .exec("SELECT id, data, version FROM documents WHERE collection = ? ORDER BY id", collection)
      .toArray()
      .map((row) => ({ id: row.id, version: row.version, data: JSON.parse(row.data as string) }));
  }

  /** One host op, run synchronously against SQLite inside the caller's transaction. */
  private host(op: string, args: unknown[], counters: { ops: number; rowsWritten: number; rowsRead: number }): unknown {
    counters.ops++;
    const doc = (row: Row | undefined) =>
      row && {
        id: row.id,
        data: JSON.parse(row.data as string),
        revision: row.version,
      };
    switch (op) {
      case "now":
        return Date.now();
      case "random": {
        const [n] = crypto.getRandomValues(new Uint32Array(1));
        return n / 2 ** 32;
      }
      case "get": {
        const [collection, id] = args as [string, string];
        return (
          doc(
            this.sql
              .exec("SELECT * FROM documents WHERE collection = ? AND id = ?", collection, id)
              .toArray()[0],
          ) ?? null
        );
      }
      case "list": {
        const [collection, filter] = args as [string, Record<string, unknown> | null];
        const clauses = ["collection = ?"];
        const bindings: SqlStorageValue[] = [collection];
        for (const [field, value] of Object.entries(filter ?? {})) {
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(field)) throw new GuestError("Bad field");
          clauses.push(`json_extract(data, '$."${field}"') = ?`);
          bindings.push(value as SqlStorageValue);
        }
        return this.sql
          .exec(
            `SELECT * FROM documents WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT 1000`,
            ...bindings,
          )
          .toArray()
          .map((row) => doc(row));
      }
      case "add":
      case "set": {
        const [collection, id, data] =
          op === "add"
            ? [args[0] as string, crypto.randomUUID(), args[1]]
            : (args as [string, string, unknown]);
        const encoded = JSON.stringify(data);
        if (encoded === undefined || encoded.length > 64 * 1024)
          throw new GuestError("Document must be JSON under 64 KiB.");
        const now = Date.now();
        const cursor = this.sql.exec(
          `INSERT INTO documents (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, version = version + 1, updated_at = excluded.updated_at`,
          collection,
          id,
          encoded,
          now,
          now,
        );
        cursor.toArray();
        counters.rowsWritten += cursor.rowsWritten;
        counters.rowsRead += cursor.rowsRead;
        return { id };
      }
      case "delete": {
        const [collection, id] = args as [string, string];
        this.sql.exec("DELETE FROM documents WHERE collection = ? AND id = ?", collection, id);
        return null;
      }
      default:
        throw new GuestError(`Unknown op ${op}`);
    }
  }

  private load(module: QuickJSWASMModule, timings: Timings, budget: number) {
    let t = performance.now();
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(MEMORY_LIMIT);
    runtime.setMaxStackSize(stackOverride ?? STACK_LIMIT);
    // Workers freeze the clock while code runs, so a wall-clock deadline
    // would never fire: count interrupt checks instead.
    const state = { checks: 0, budget };
    runtime.setInterruptHandler(() => ++state.checks > state.budget);
    const context = runtime.newContext();
    timings.newContext = performance.now() - t;

    t = performance.now();
    context.unwrapResult(context.evalCode(PRELUDE, "prelude.js", { type: "global" })).dispose();
    const exports = context.unwrapResult(
      context.evalCode(this.source!, "functions.js", { type: "module" }),
    );
    context.setProp(context.global, "__exports", exports);
    timings.evalSource = performance.now() - t;
    return { context, exports, state };
  }

  call(name: string, member: string, args: unknown, reuse: boolean, budget = DEFAULT_INTERRUPT_BUDGET, perCall = false, stack?: number, wasmMax?: number): Promise<Record<string, unknown>> {
    stackOverride = stack;
    wasmMaxOverride = wasmMax;
    return Promise.resolve().then(() => this.callInner(name, member, args, reuse, budget, perCall)).catch((error: unknown) => {
      // An Emscripten abort leaves the wasm instance unusable: drop it.
      quickjs = undefined;
      this.cached = undefined;
      return { ok: false, error: `host: ${String(error)}`, instanceReset: true };
    });
  }

  /** Runs a call n times in a row in this object; per-call average, since the clock is coarse. */
  async bench(name: string, args: unknown, n: number, mode: "call" | "isolate" | "reuse") {
    const t = performance.now();
    let last: Record<string, unknown> = {};
    for (let i = 0; i < n; i++)
      last = await this.call(name, "wallets-0", args, mode === "reuse", DEFAULT_INTERRUPT_BUDGET, mode === "call");
    return { perCallMs: (performance.now() - t) / n, n, last: { ok: last.ok, value: last.value, hostOps: last.hostOps } };
  }

  private callInner(name: string, member: string, args: unknown, reuse: boolean, budget: number, perCall: boolean): Promise<Record<string, unknown>> | Record<string, unknown> {
    if (this.source === null) return { ok: false, error: "No functions deployed." };
    const timings: Timings = {};
    const started = performance.now();
    const dateStarted = Date.now();
    const loading = perCall
      ? (() => {
          const t = performance.now();
          return newModule(wasmMaxOverride).then((module) => {
            timings.instantiateWasm = performance.now() - t;
            return module;
          });
        })()
      : this.loadModule(timings);
    return loading.then((module) => {
      const counters = { ops: 0, rowsWritten: 0, rowsRead: 0 };
      let loaded: ReturnType<Site["load"]> | undefined;
      let state = { checks: 0, budget };
      let context: QuickJSContext;
      if (reuse && this.cached) {
        context = this.cached.context;
        state = this.cached.state;
        state.checks = 0;
        state.budget = budget;
      } else {
        loaded = this.load(module, timings, budget);
        context = loaded.context;
        state = loaded.state;
        if (reuse) this.cached = { context, exports: loaded.exports, state };
      }
      const hostFn = context.newFunction("__host", (opHandle, argsHandle) => {
        try {
          const out = this.host(
            context.getString(opHandle),
            JSON.parse(context.getString(argsHandle)),
            counters,
          );
          return out === undefined ? context.undefined : context.newString(JSON.stringify(out));
        } catch (error) {
          return { error: context.newError(error instanceof Error ? error.message : String(error)) };
        }
      });
      context.setProp(context.global, "__host", hostFn);
      hostFn.dispose();

      let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
      const t = performance.now();
      try {
        const value = this.ctx.storage.transactionSync(() => {
          const result = context.evalCode(
            `__run(${JSON.stringify(name)}, ${JSON.stringify(member)}, ${JSON.stringify(JSON.stringify(args ?? null))})`,
            "call.js",
            { type: "global" },
          );
          if (result.error) {
            const error = context.dump(result.error);
            result.error.dispose();
            throw new GuestError(JSON.stringify(error)); // rolls back
          }
          const json = context.getString(result.value);
          result.value.dispose();
          return JSON.parse(json);
        });
        outcome = { ok: true, value };
      } catch (error) {
        outcome = { ok: false, error: error instanceof GuestError ? JSON.parse(error.message) : String(error) };
      }
      timings.call = performance.now() - t;
      timings.total = performance.now() - started;
      const memory = context.runtime.computeMemoryUsage();
      const memoryUsed = context.getNumber(context.getProp(memory, "memory_used_size"));
      memory.dispose();
      if (!reuse && !perCall) {
        loaded!.exports.dispose();
        const runtime = context.runtime;
        context.dispose();
        runtime.dispose();
      }
      // perCall: the whole wasm instance is dropped, never freed. QuickJS-ng
      // leaks objects after a stack overflow, and JS_FreeRuntime then aborts.
      return {
        ...outcome,
        hostOps: counters.ops,
        rowsWritten: counters.rowsWritten,
        interruptChecks: state.checks,
        memoryUsed,
        timings,
        dateNowAdvanced: Date.now() - dateStarted,
      };
    });
  }

  private loadModule(timings: Timings) {
    if (!quickjs) {
      const t = performance.now();
      quickjs = newModule().then((module) => {
        timings.instantiateWasm = performance.now() - t;
        return module;
      });
    }
    return quickjs;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (!env.SPIKE_TOKEN || request.headers.get("x-spike-token") !== env.SPIKE_TOKEN)
      return new Response("forbidden", { status: 403 });
    const site = env.SITES.get(env.SITES.idFromName(url.searchParams.get("site") ?? "spike"));
    const [, action, name] = url.pathname.split("/");
    const json = (value: unknown) => Response.json(value);
    switch (action) {
      case "deploy":
        return json(await site.deploy(await request.text()));
      case "seed":
        return json(
          await site.seed(name, await request.json()),
        );
      case "noop": {
        const t = performance.now();
        await site.dump("none");
        return json({ rpcMs: performance.now() - t });
      }
      case "bench": {
        const t = performance.now();
        const result = await site.bench(
            name,
            JSON.parse((await request.text()) || "null"),
            Number(url.searchParams.get("n") ?? 200),
            (url.searchParams.get("mode") ?? "call") as "call" | "isolate" | "reuse",
          );
        return json({ ...(result as Record<string, unknown>), workerMs: performance.now() - t });
      }
      case "dump":
        return json(await site.dump(name));
      case "call": {
        const t = performance.now();
        const body = await request.text();
        const result = await site.call(
          name,
          url.searchParams.get("member") ?? "m1",
          body ? JSON.parse(body) : null,
          url.searchParams.get("reuse") === "1",
          url.searchParams.has("budget") ? Number(url.searchParams.get("budget")) : undefined,
          url.searchParams.get("instance") !== "isolate",
          url.searchParams.has("stack") ? Number(url.searchParams.get("stack")) : undefined,
          url.searchParams.has("wasmMax") ? Number(url.searchParams.get("wasmMax")) : undefined,
        );
        return json({ ...(result as Record<string, unknown>), workerMs: performance.now() - t });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  },
};
