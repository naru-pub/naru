import { resolveModule, type ModuleSources } from "./modules";
import { hashPassword, verifyPassword } from "./passwords";
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";
import {
  DataError,
  ERROR_CODES,
  type ErrorCode,
} from "../../control-plane/src/lib/site-data/validation";

// Site functions: the owner's modules in _naru/functions/, run by QuickJS (compiled to
// WebAssembly) inside the site's object, synchronously, so a call's reads and
// writes are one SQLite transaction (site.ts). Nothing here touches storage:
// what a function may do arrives as `host`, so functions.test.ts runs this in
// plain Node.
//
// ctx's database methods return promises, so functions are written as they
// would be against any asynchronous store. Here the host answers at once and
// the call drains QuickJS's job queue before returning, so an async function
// still settles within the one transaction.
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
// Calls share one WebAssembly instance (quickjs.ts), each in its own runtime
// and context, which the call frees, with every handle it held, before it
// returns: nothing of one call reaches the next. A call that leaves the
// instance in doubt retires it instead (`retired`): one interrupted, out of
// memory, failed inside the engine, or whose runtime would not free cleanly.
// The spike found such instances can be corrupt; a retired one is dropped,
// never freed, and the next call starts a new one.

/** About 70 ms of interpreting on Cloudflare's hardware (the spike's). */
export const INTERRUPT_BUDGET = 2000;
export const STACK_BYTES = 128 * 1024;
export const MAX_OPERATIONS = 100;
export const MAX_WRITES = 25;
export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_FAILURE_DETAILS_BYTES = 4 * 1024;
/** URL parses a call may make: each is host time the interrupt checks miss. */
export const MAX_URL_PARSES = 1000;
/**
 * Promise jobs (each step of an async function) a call may run. A job too
 * small to reach QuickJS's next interrupt check escapes the CPU budget, so
 * `for (;;) await null` would otherwise run some thirty times past it.
 */
export const MAX_JOBS = 10_000;
/**
 * Password hashes or checks a call may make (ctx.password): each is a few
 * milliseconds of host time the interrupt checks cannot see.
 */
export const MAX_PASSWORD_OPERATIONS = 3;
/** Live messages a call may send (ctx.notify, ctx.broadcast). */
export const MAX_MESSAGES = 50;
const MESSAGES = new Set(["notify", "broadcast"]);
const URL_PARTS = [
  "href",
  "origin",
  "protocol",
  "username",
  "password",
  "host",
  "hostname",
  "port",
  "pathname",
  "search",
  "hash",
] as const;
const URL_SETTERS = new Set(URL_PARTS.slice(2));
export const WRITES = new Set(["add", "set", "delete", "mediaDelete"]);

/** What a function may do: one call per ctx method, given its arguments. */
export type Host = (operation: string, args: unknown[]) => unknown;

export type Invocation = {
  source: string;
  filename?: string;
  modules?: ModuleSources;
  name: string;
  args: unknown;
  member: string | null;
  /** The site's owner called, rather than a member or the site itself. */
  owner?: boolean;
  /** A visitor called, signed in to nothing (`export const visitors`). */
  visitor?: boolean;
  now: number;
  readonly?: boolean;
  /** A larger result cap, for rules presenting a page of documents. */
  maxResultBytes?: number;
};

const failed = (message: string) =>
  new DataError(400, `Function failed: ${message}`);

/** Instances a call left in doubt, which no further call may use. */
export const retired = new WeakSet<QuickJSWASMModule>();

// Guest side: one host entry point, JSON across the boundary. A failing ctx
// operation fails the whole call (the host keeps the error and rethrows it
// afterwards), so a function cannot carry on past one. The database methods
// are async: the operation runs when called, and its promise is how the
// function gets the answer.
//
// Each of those promises must be used (awaited, chained or passed to
// Promise.all), or the call fails: `if (!ctx.get(...))` is always false, a
// mistake no error would otherwise reveal. A native promise cannot tell when
// it is awaited, so these are a subclass whose then() is observable; what
// then() returns is a plain promise.
const PRELUDE = `
const __call = (operation, ...args) => {
  const out = __host(operation, JSON.stringify(args));
  return out === undefined ? undefined : JSON.parse(out);
};
Math.random = () => __call("random");
// URL and URLSearchParams, as browsers have them. The host's own URL parses
// (QuickJS has none); the parameter list is kept here.
const __urlParts = (input, base, key, value) =>
  __call("url", String(input), base === undefined ? null : String(base), key ?? null, value === undefined ? null : String(value));
const __formEncode = (value) =>
  encodeURIComponent(value)
    .replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, "+");
const __formDecode = (value) => {
  const text = value.replace(/\\+/g, " ");
  try { return decodeURIComponent(text); } catch { return text; }
};
const __searchOwners = new WeakMap();
class URLSearchParams {
  #list = [];
  constructor(init = "") {
    if (typeof init === "object" && init !== null) {
      if (typeof init[Symbol.iterator] === "function")
        for (const pair of init) {
          const entry = [...pair];
          if (entry.length !== 2) throw new TypeError("Each pair must have a name and a value.");
          this.#list.push([String(entry[0]), String(entry[1])]);
        }
      else for (const key of Object.keys(init)) this.#list.push([key, String(init[key])]);
    } else this.#parse(String(init));
  }
  #parse(text) {
    this.#list = [];
    for (const part of (text.startsWith("?") ? text.slice(1) : text).split("&")) {
      if (!part) continue;
      const at = part.indexOf("=");
      this.#list.push(at < 0 ? [__formDecode(part), ""] : [__formDecode(part.slice(0, at)), __formDecode(part.slice(at + 1))]);
    }
  }
  #changed() {
    const owner = __searchOwners.get(this);
    if (owner) owner.__setSearch(this.toString());
  }
  static __reparse(params, text) { params.#parse(text); }
  get size() { return this.#list.length; }
  append(name, value) { this.#list.push([String(name), String(value)]); this.#changed(); }
  delete(name, value) {
    this.#list = this.#list.filter(([key, item]) => key !== String(name) || (value !== undefined && item !== String(value)));
    this.#changed();
  }
  get(name) { return this.#list.find(([key]) => key === String(name))?.[1] ?? null; }
  getAll(name) { return this.#list.filter(([key]) => key === String(name)).map(([, value]) => value); }
  has(name, value) { return this.#list.some(([key, item]) => key === String(name) && (value === undefined || item === String(value))); }
  set(name, value) {
    const at = this.#list.findIndex(([key]) => key === String(name));
    if (at < 0) this.#list.push([String(name), String(value)]);
    else {
      this.#list[at] = [String(name), String(value)];
      this.#list = this.#list.filter(([key], index) => index <= at || key !== String(name));
    }
    this.#changed();
  }
  sort() { this.#list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); this.#changed(); }
  forEach(callback, thisArg) { for (const [key, value] of this.#list) callback.call(thisArg, value, key, this); }
  *keys() { for (const [key] of this.#list) yield key; }
  *values() { for (const [, value] of this.#list) yield value; }
  *entries() { for (const [key, value] of this.#list) yield [key, value]; }
  [Symbol.iterator]() { return this.entries(); }
  toString() { return this.#list.map(([key, value]) => __formEncode(key) + "=" + __formEncode(value)).join("&"); }
}
class URL {
  #parts;
  #params = null;
  constructor(input, base) {
    const parts = __urlParts(input, base);
    if (!parts) throw new TypeError("Invalid URL: " + String(input));
    this.#parts = parts;
  }
  static canParse(input, base) { return __urlParts(input, base) !== null; }
  static parse(input, base) { const parts = __urlParts(input, base); if (!parts) return null; const url = new URL(parts.href); return url; }
  #set(key, value) {
    const parts = __urlParts(this.#parts.href, undefined, key, value);
    if (!parts) throw new TypeError("Invalid URL");
    this.#parts = parts;
    if (this.#params && key !== "hash") URLSearchParams.__reparse(this.#params, parts.search);
  }
  __setSearch(text) { this.#parts = __urlParts(this.#parts.href, undefined, "search", text); }
  get href() { return this.#parts.href; } set href(value) { const parts = __urlParts(value); if (!parts) throw new TypeError("Invalid URL: " + String(value)); this.#parts = parts; if (this.#params) URLSearchParams.__reparse(this.#params, parts.search); }
  get origin() { return this.#parts.origin; }
  get protocol() { return this.#parts.protocol; } set protocol(value) { this.#set("protocol", value); }
  get username() { return this.#parts.username; } set username(value) { this.#set("username", value); }
  get password() { return this.#parts.password; } set password(value) { this.#set("password", value); }
  get host() { return this.#parts.host; } set host(value) { this.#set("host", value); }
  get hostname() { return this.#parts.hostname; } set hostname(value) { this.#set("hostname", value); }
  get port() { return this.#parts.port; } set port(value) { this.#set("port", value); }
  get pathname() { return this.#parts.pathname; } set pathname(value) { this.#set("pathname", value); }
  get search() { return this.#parts.search; } set search(value) { this.#set("search", value); }
  get hash() { return this.#parts.hash; } set hash(value) { this.#set("hash", value); }
  get searchParams() {
    if (!this.#params) {
      this.#params = new URLSearchParams(this.#parts.search);
      __searchOwners.set(this.#params, this);
    }
    return this.#params;
  }
  toString() { return this.#parts.href; }
  toJSON() { return this.#parts.href; }
}
globalThis.URL = URL;
globalThis.URLSearchParams = URLSearchParams;
const __unused = new Map();
class CtxPromise extends Promise {
  static get [Symbol.species]() { return Promise; }
  then(onFulfilled, onRejected) {
    __unused.delete(this);
    return super.then(onFulfilled, onRejected);
  }
}
const __operation = (operation) => (...args) => {
  let settle;
  try {
    const value = __call(operation, ...args);
    settle = (resolve) => resolve(value);
  } catch (error) {
    settle = (resolve, reject) => reject(error);
  }
  const promise = new CtxPromise(settle);
  __unused.set(promise, operation);
  return promise;
};
globalThis.__unawaited = () => __unused.values().next().value;
globalThis.__run = async (name, member, owner, visitor, now, args) => {
  const ctx = Object.freeze({
    member: member === null ? null : Object.freeze({ id: member }),
    owner,
    visitor,
    now,
    password: Object.freeze({
      hash: (password) => __call("passwordHash", password),
      verify: (password, hash) => __call("passwordVerify", password, hash),
    }),
    random: () => __call("random"),
    fail: (...args) => __call("fail", ...args),
    get: __operation("get"),
    getMany: __operation("getMany"),
    count: (collection, options) =>
      __operation("count")(collection, options ?? {}),
    list: (collection, options) =>
      __operation("list")(collection, options ?? {}),
    add: __operation("add"),
    set: __operation("set"),
    secretMatches: __operation("secretMatches"),
    delete: __operation("delete"),
    media: Object.freeze({ delete: __operation("mediaDelete") }),
    notify: (member, data) => __call("notify", member, data ?? null),
    broadcast: (topic, data) => __call("broadcast", topic, data ?? null),
  });
  const fn = Object.hasOwn(globalThis.__exports, name)
    ? globalThis.__exports[name]
    : undefined;
  if (typeof fn !== "function")
    throw Object.assign(new Error(name), { name: "__Missing" });
  return JSON.stringify((await fn(ctx, JSON.parse(args))) ?? null);
};
`;

/**
 * Runs `name` from `source` with `args`, synchronously, settling it if it is
 * async. Returns what it returned (or resolved with), as JSON. Throws a DataError: the host's own when a ctx operation
 * failed, otherwise a 400 describing the function's failure or limit.
 */
export function runFunction(
  module: QuickJSWASMModule,
  invocation: Invocation,
  host: Host,
): unknown {
  if (retired.has(module))
    throw new Error("A retired QuickJS instance was asked to run a call.");
  const runtime = module.newRuntime();
  let context: QuickJSContext | undefined;
  const owned: QuickJSHandle[] = [];
  const own = <T extends QuickJSHandle>(handle: T) => (
    owned.push(handle),
    handle
  );
  // Set when the call ran out of CPU or memory: its instance is retired.
  const spent = { cpu: false, memory: false };
  let clean = false;
  try {
    const result = execute();
    clean = true;
    return result;
  } catch (error) {
    clean = error instanceof DataError;
    throw error;
  } finally {
    if (clean && !spent.cpu && !spent.memory)
      try {
        for (const handle of owned) if (handle.alive) handle.dispose();
        context?.dispose();
        runtime.dispose();
      } catch {
        clean = false;
      }
    else clean = false;
    if (!clean) retired.add(module);
  }

  function execute(): unknown {
    runtime.setMaxStackSize(STACK_BYTES);
    let checks = 0;
    // Once spent, the budget stays spent: every later check interrupts too, so
    // even reading the error object could fail, and this says why instead.
    let interrupted = false;
    runtime.setInterruptHandler(() => {
      if (++checks > INTERRUPT_BUDGET) interrupted = spent.cpu = true;
      return interrupted;
    });
    if (invocation.modules)
      runtime.setModuleLoader((filename) => {
        const source = invocation.modules![filename];
        if (source === undefined)
          throw failed(`module ${filename} was not preloaded.`);
        return source;
      }, resolveModule);
    const context = runtime.newContext();
    setContext(context);
    let operations = 0;
    let writes = 0;
    let parses = 0;
    let messages = 0;
    let passwords = 0;
    let hostError: DataError | undefined;
    const entry = context.newFunction("__host", (operation, args) => {
      const name = context.getString(operation);
      try {
        if (hostError) throw hostError;
        if (name === "url") {
          if (++parses > MAX_URL_PARSES)
            throw failed(`more than ${MAX_URL_PARSES} URL operations.`);
          const [input, base, key, value] = JSON.parse(context.getString(args));
          let url: URL;
          try {
            url = new URL(input, base ?? undefined);
            if (key !== null) {
              if (!URL_SETTERS.has(key)) return context.newString("null");
              (url as unknown as Record<string, string>)[key] = value;
            }
          } catch {
            return context.newString("null");
          }
          return context.newString(
            JSON.stringify(
              Object.fromEntries(URL_PARTS.map((part) => [part, url[part]])),
            ),
          );
        }
        if (name === "passwordHash" || name === "passwordVerify") {
          if (++passwords > MAX_PASSWORD_OPERATIONS)
            throw failed(
              `more than ${MAX_PASSWORD_OPERATIONS} password operations.`,
            );
          const [password, stored] = JSON.parse(context.getString(args));
          if (
            typeof password !== "string" ||
            !password ||
            password.length > 256
          )
            throw failed("a password is 1–256 characters.");
          if (name === "passwordHash")
            return context.newString(JSON.stringify(hashPassword(password)));
          const verified = verifyPassword(password, stored);
          if (verified === null)
            throw failed(
              "ctx.password.verify needs a hash from ctx.password.hash.",
            );
          return context.newString(JSON.stringify(verified));
        }
        if (name === "fail") {
          const json = context.getString(args);
          const [code, message, details = null] = JSON.parse(json);
          if (
            !ERROR_CODES.includes(code) ||
            typeof message !== "string" ||
            !message.trim() ||
            message.length > 1000
          )
            throw failed(
              "ctx.fail requires a v1 error code and a message of 1–1000 characters.",
            );
          // The caller's own JSON: a reason the page can branch on, say.
          if (
            details !== null &&
            new TextEncoder().encode(JSON.stringify(details)).byteLength >
              MAX_FAILURE_DETAILS_BYTES
          )
            throw failed("ctx.fail details must be at most 4 KiB of JSON.");
          const status: Record<ErrorCode, number> = {
            CONFLICT: 409,
            QUOTA_EXCEEDED: 409,
            AUTH_REQUIRED: 401,
            ACCESS_DENIED: 403,
            NOT_FOUND: 404,
            RATE_LIMITED: 429,
            INVALID_REQUEST: 400,
            UNAVAILABLE: 503,
          };
          throw new DataError(
            status[code as ErrorCode],
            message,
            code,
            details ?? undefined,
          );
        }
        const values = JSON.parse(context.getString(args));
        if (MESSAGES.has(name)) {
          if (invocation.readonly)
            throw failed("read-only functions cannot send messages.");
          if (++messages > MAX_MESSAGES)
            throw failed(`more than ${MAX_MESSAGES} live messages.`);
          const out = host(name, values);
          return out === undefined
            ? context.undefined
            : context.newString(JSON.stringify(out));
        }
        if (
          name === "getMany" &&
          (!Array.isArray(values[1]) || values[1].length > MAX_OPERATIONS)
        )
          throw failed(
            `getMany needs an array of at most ${MAX_OPERATIONS} IDs.`,
          );
        // A document secret is checked with the hash ctx.password uses.
        if (
          name === "secretMatches" &&
          ++passwords > MAX_PASSWORD_OPERATIONS
        )
          throw failed(
            `more than ${MAX_PASSWORD_OPERATIONS} password operations.`,
          );
        operations += name === "getMany" ? Math.max(1, values[1].length) : 1;
        if (operations > MAX_OPERATIONS)
          throw failed(`more than ${MAX_OPERATIONS} database operations.`);
        if (invocation.readonly && WRITES.has(name))
          throw failed("read-only functions cannot write.");
        // The control plane deletes queued uploads after a call, and a
        // visitor's call may be answered without it.
        if (invocation.visitor && name === "mediaDelete")
          throw failed("a visitor's call cannot delete uploads.");
        if (WRITES.has(name) && ++writes > MAX_WRITES)
          throw failed(`more than ${MAX_WRITES} writes.`);
        const out = host(name, values);
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
    evaluate(context, PRELUDE, "prelude.js", "global", own);
    let exports: QuickJSHandle;
    try {
      exports = evaluate(
        context,
        invocation.source,
        invocation.filename ?? "functions.js",
        "module",
        own,
      );
    } catch (error) {
      const reason = describe(error);
      if (reason === "it used too much memory.") spent.memory = true;
      if (interrupted) spent.cpu = true;
      throw failed(`its module does not load: ${reason}`);
    }
    context.setProp(context.global, "__exports", exports);
    /** What a call's exception means: the host's error first, then the function's. */
    const outcome = (exception: QuickJSHandle) => {
      own(exception);
      if (interrupted) spent.cpu = true;
      if (hostError) return hostError;
      if (interrupted) return failed("it ran too long.");
      const error = context.dump(exception) as { name?: string };
      if (error?.name === "__Missing")
        return new DataError(404, `No function ${invocation.name}.`);
      const reason = describe(error);
      if (reason === "it used too much memory.") spent.memory = true;
      return failed(reason);
    };
    const call = context.evalCode(
      `__run(${[
        invocation.name,
        invocation.member,
        invocation.owner === true,
        invocation.visitor === true,
        invocation.now,
        JSON.stringify(invocation.args ?? null),
      ]
        .map((value) => JSON.stringify(value))
        .join(", ")})`,
      "call.js",
      { type: "global" },
    );
    if (call.error) throw outcome(call.error);
    own(call.value);
    // Every ctx operation has already been answered, so draining the queue
    // settles the call unless it awaits something no one will ever resolve.
    for (let ran = 0; ; ) {
      const jobs = runtime.executePendingJobs(1000);
      if (jobs.error) throw outcome(jobs.error);
      if (jobs.value === 0) break;
      ran += jobs.value;
      if (ran > MAX_JOBS) {
        spent.cpu = true;
        throw failed("it ran too long.");
      }
    }
    const state = context.getPromiseState(call.value);
    if (state.type === "rejected") throw outcome(state.error);
    if (state.type === "fulfilled") own(state.value);
    if (hostError) throw hostError;
    if (state.type === "pending")
      throw failed("it awaited something other than ctx, which never settles.");
    const unawaited = context.dump(
      evaluate(context, "__unawaited()", "check.js", "global", own),
    );
    if (unawaited !== undefined)
      throw failed(`it did not await ctx.${unawaited}.`);
    const json = context.getString(state.value);
    if (
      new TextEncoder().encode(json).byteLength >
      (invocation.maxResultBytes ?? MAX_RESULT_BYTES)
    )
      throw failed("its result is larger than 64 KiB.");
    return JSON.parse(json);
  }

  function setContext(value: QuickJSContext) {
    context = value;
  }
}

/** Evaluates `code`, keeping its result and any error handle with `own`. */
function evaluate(
  context: QuickJSContext,
  code: string,
  file: string,
  type: "global" | "module",
  own: (handle: QuickJSHandle) => QuickJSHandle,
) {
  const result = context.evalCode(code, file, { type });
  if (result.error) {
    const error = context.dump(own(result.error));
    throw new Error(describe(error));
  }
  return own(result.value);
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
