import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { DataError } from "../../control-plane/src/lib/site-data/validation";

// Site functions: the owner's modules in _naru/functions/, run by QuickJS (compiled to
// WebAssembly) inside the site's object, synchronously, so a call's reads and
// writes are one SQLite transaction (site.ts). Nothing here touches storage:
// what a function may do arrives as `host`, so functions.test.ts runs this in
// plain Node.
//
// The limits are the spike's findings (spikes/quickjs-functions/README.md):
// - CPU is bounded by counting QuickJS's interrupt checks, not by a clock,
//   which Workers stop while code runs;
// - memory is bounded by the WebAssembly memory itself (the module is built
//   with that cap, see quickjs.ts), since QuickJS's own limit misses most
//   allocations in this build;
// - the QuickJS stack stays well under the host's, whose overflow mid-call
//   would corrupt the interpreter;
// - calls into the host are counted, since time spent there is invisible to
//   the interrupt checks.
// Each call gets its own instance, which is then dropped, never freed: a
// failed call cannot leave anything behind for the next.

/** About 70 ms of interpreting on Cloudflare's hardware (the spike's). */
export const INTERRUPT_BUDGET = 2000;
export const STACK_BYTES = 128 * 1024;
export const MAX_OPERATIONS = 100;
export const MAX_WRITES = 25;
export const MAX_RESULT_BYTES = 64 * 1024;
export const WRITES = new Set(["add", "set", "delete"]);

/** What a function may do: one call per ctx method, given its arguments. */
export type Host = (operation: string, args: unknown[]) => unknown;

export type Invocation = {
  source: string;
  name: string;
  args: unknown;
  member: string;
  now: number;
  readonly?: boolean;
};

const failed = (message: string) =>
  new DataError(400, `Function failed: ${message}`);

// Guest side: one host entry point, JSON across the boundary. A failing ctx
// operation fails the whole call (the host keeps the error and rethrows it
// afterwards), so a function cannot carry on past one.
const PRELUDE = `
const __call = (operation, ...args) => {
  const out = __host(operation, JSON.stringify(args));
  return out === undefined ? undefined : JSON.parse(out);
};
Math.random = () => __call("random");
globalThis.__run = (name, member, now, args) => {
  const ctx = Object.freeze({
    member: Object.freeze({ id: member }),
    now,
    random: () => __call("random"),
    get: (collection, id) => __call("get", collection, id),
    list: (collection, options) => __call("list", collection, options ?? {}),
    add: (collection, data) => __call("add", collection, data),
    set: (collection, id, data) => __call("set", collection, id, data),
    delete: (collection, id) => __call("delete", collection, id),
  });
  const fn = Object.hasOwn(globalThis.__exports, name)
    ? globalThis.__exports[name]
    : undefined;
  if (typeof fn !== "function")
    throw Object.assign(new Error(name), { name: "__Missing" });
  const result = fn(ctx, JSON.parse(args));
  if (result && typeof result.then === "function")
    throw new TypeError("Functions are synchronous: return a value, not a promise.");
  return JSON.stringify(result ?? null);
};
`;

/**
 * Runs `name` from `source` with `args`, synchronously. Resolves with what it
 * returned, as JSON. Throws a DataError: the host's own when a ctx operation
 * failed, otherwise a 400 describing the function's failure or limit.
 */
export function runFunction(
  module: QuickJSWASMModule,
  invocation: Invocation,
  host: Host,
): unknown {
  const runtime = module.newRuntime();
  runtime.setMaxStackSize(STACK_BYTES);
  let checks = 0;
  runtime.setInterruptHandler(() => ++checks > INTERRUPT_BUDGET);
  const context = runtime.newContext();
  let operations = 0;
  let writes = 0;
  let hostError: DataError | undefined;
  const entry = context.newFunction("__host", (operation, args) => {
    const name = context.getString(operation);
    try {
      if (hostError) throw hostError;
      if (++operations > MAX_OPERATIONS)
        throw failed(`more than ${MAX_OPERATIONS} database operations.`);
      if (invocation.readonly && WRITES.has(name))
        throw failed("read-only functions cannot write.");
      if (WRITES.has(name) && ++writes > MAX_WRITES)
        throw failed(`more than ${MAX_WRITES} writes.`);
      const out = host(name, JSON.parse(context.getString(args)));
      return out === undefined
        ? context.undefined
        : context.newString(JSON.stringify(out));
    } catch (error) {
      hostError ??=
        error instanceof DataError
          ? error
          : new DataError(500, "Function storage failed.");
      return { error: context.newError(hostError.message) };
    }
  });
  context.setProp(context.global, "__host", entry);
  entry.dispose();
  evaluate(context, PRELUDE, "prelude.js", "global").dispose();
  let exports: QuickJSHandle;
  try {
    exports = evaluate(context, invocation.source, "functions.js", "module");
  } catch (error) {
    throw failed(`its module does not load: ${describe(error)}`);
  }
  context.setProp(context.global, "__exports", exports);
  const call = context.evalCode(
    `__run(${[
      invocation.name,
      invocation.member,
      invocation.now,
      JSON.stringify(invocation.args ?? null),
    ]
      .map((value) => JSON.stringify(value))
      .join(", ")})`,
    "call.js",
    { type: "global" },
  );
  if (hostError) throw hostError;
  if (call.error) {
    const error = context.dump(call.error) as { name?: string };
    if (error?.name === "__Missing")
      throw new DataError(404, `No function ${invocation.name}.`);
    throw failed(describe(error));
  }
  const json = context.getString(call.value);
  if (new TextEncoder().encode(json).byteLength > MAX_RESULT_BYTES)
    throw failed("its result is larger than 64 KiB.");
  return JSON.parse(json);
}

function evaluate(
  context: QuickJSContext,
  code: string,
  file: string,
  type: "global" | "module",
) {
  const result = context.evalCode(code, file, { type });
  if (result.error) {
    const error = context.dump(result.error);
    throw new Error(describe(error));
  }
  return result.value;
}

function describe(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const { name, message } = error as { name?: string; message?: string };
  if (name === "InternalError" && message === "interrupted")
    return "it ran too long.";
  if (name === "InternalError" && message === "out of memory")
    return "it used too much memory.";
  return `${name ?? "Error"}: ${message ?? ""}`;
}
