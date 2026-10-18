import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { DataError } from "../../control-plane/src/lib/site-data/validation";
import { newEngine } from "./engine";
import {
  MAX_OPERATIONS,
  MAX_PASSWORD_OPERATIONS,
  retired,
  runFunction,
  type Host,
  type Invocation,
} from "./functions";

// The engine in plain Node: the Worker's metered QuickJS build (engine.ts),
// with an in-memory host standing in for the site's object.
// (Workers' types declare no WebAssembly.Module constructor; Node has one.)
const metered = new (
  WebAssembly.Module as unknown as new (bytes: Uint8Array) => WebAssembly.Module
)(readFileSync(new URL("../quickjs/metered.wasm", import.meta.url)));
const engine = () => newEngine(metered);

let module: QuickJSWASMModule;
let wallets: Map<string, number>;
let operations: [string, unknown[]][];
// Site SQL as the object answers it, for the few statements these tests
// run: a wallet's balance, read and written, and a table that is always full.
const host: Host = (operation, args) => {
  operations.push([operation, args]);
  switch (operation) {
    case "random":
      return 0.5;
    case "rolesOf":
      return { m1: ["staff"] };
    case "passwordHash":
      return `hash:${args[0]}`;
    case "passwordVerify":
      return args[1] === `hash:${args[0]}`;
    case "sql": {
      const [text, values, readonly] = args as [string, unknown[], boolean];
      if (readonly && !/^SELECT/i.test(text))
        throw new DataError(400, "A query's SQL only reads.");
      if (/^SELECT balance FROM wallets/.test(text)) {
        const balance = wallets.get(String(values[0]));
        return {
          rows: balance === undefined ? [] : [{ balance }],
          changes: 0,
        };
      }
      if (/^UPDATE wallets SET balance/.test(text)) {
        wallets.set(String(values[1]), Number(values[0]));
        return { rows: [], changes: 1 };
      }
      if (/^INSERT INTO full/.test(text))
        throw new DataError(
          409,
          "Site database quota exceeded.",
          "QUOTA_EXCEEDED",
        );
      return { rows: [], changes: 0 };
    }
    default:
      throw new DataError(400, `ctx has no ${operation}.`);
  }
};
const run = (
  source: string,
  name: string,
  args: unknown = null,
  kind: Invocation["kind"] = "mutation",
) =>
  runFunction(
    module,
    {
      source,
      name,
      args,
      member: "m-1",
      now: 1_700_000_000_000,
      kind,
      readonly: kind !== "mutation",
    },
    host,
  );

beforeEach(async () => {
  module = await engine();
  wallets = new Map();
  operations = [];
});
// Calls share an instance, so an ordinary call, failed or not, must leave it
// usable: only exhausting CPU or memory retires it (tested where it does).
afterEach(() => {
  expect(retired.has(module)).toBe(false);
});

test("one instance serves many calls, each freed before the next", () => {
  wallets.set("m-1", 0);
  // A megabyte a call, 100 MB in all: past the instance's 32 MiB unless freed.
  for (let n = 0; n < 100; n++)
    expect(
      run(
        `let calls = 0;
        export async function f(ctx) {
          const filler = "x".repeat(1 << 20);
          const { rows } = await ctx.sql\`SELECT balance FROM wallets WHERE id = \${ctx.member.id}\`;
          globalThis.leaked = filler;
          return [++calls, rows[0].balance, filler.length];
        }`,
        "f",
      ),
    ).toEqual([1, 0, 1 << 20]);
  try {
    run(`export function f(ctx) { ctx.fail("CONFLICT", "No."); }`, "f");
  } catch {}
  try {
    run(
      `export async function f(ctx) { await ctx.sql("INSERT INTO full VALUES (1)"); }`,
      "f",
    );
  } catch {}
});

describe("calling", () => {
  test("site code gets ctx and its arguments, and returns JSON", () => {
    wallets.set("m-1", 150);
    const result = run(
      `export async function buy(ctx, { item, price }) {
        const { rows: [wallet] } = await ctx.sql\`SELECT balance FROM wallets WHERE id = \${ctx.member.id}\`;
        if (wallet.balance < price) return { ok: false };
        await ctx.sql("UPDATE wallets SET balance = ? WHERE id = ?", [wallet.balance - price, ctx.member.id]);
        return { ok: true, item, at: ctx.now, roll: Math.random(), more: [ctx.random, ctx.get, ctx.notify] };
      }`,
      "buy",
      { item: "sword", price: 100 },
    );
    expect(result).toEqual({
      ok: true,
      item: "sword",
      at: 1_700_000_000_000,
      roll: 0.5,
      // Math.random is the host's; ctx keeps no second way to it, and no
      // collection or message methods.
      more: [null, null, null],
    });
    expect(wallets.get("m-1")).toBe(50);
    // A tagged template binds its values as parameters.
    expect(operations[0]).toEqual([
      "sql",
      ["SELECT balance FROM wallets WHERE id = ?", ["m-1"], false],
    ]);
  });

  test("ctx.owner says the site's owner called", () => {
    const source =
      "export function who(ctx) { return [ctx.owner, ctx.member]; }";
    expect(run(source, "who")).toEqual([false, { id: "m-1", roles: [] }]);
    expect(
      runFunction(
        module,
        {
          source,
          name: "who",
          args: null,
          member: null,
          owner: true,
          now: 0,
          kind: "mutation",
        },
        host,
      ),
    ).toEqual([true, null]);
  });

  test("a visitor's call says so", () => {
    const visit = (source: string) =>
      runFunction(
        module,
        {
          source,
          name: "f",
          args: null,
          member: null,
          visitor: true,
          now: 0,
          kind: "query",
          readonly: true,
        },
        host,
      );
    expect(
      visit(
        "export function f(ctx) { return [ctx.visitor, ctx.owner, ctx.member]; }",
      ),
    ).toEqual([true, false, null]);
    expect(run("export function f(ctx) { return ctx.visitor; }", "f")).toBe(
      false,
    );
    // Uploads are deleted by their owner or member, never by site code:
    // ctx.media reads them only.
    expect(
      visit("export function f(ctx) { return Object.keys(ctx.media); }"),
    ).toEqual(["types"]);
  });

  test("ctx.fail carries the code's details to the caller", () => {
    const failure = (args: string) => {
      try {
        run(`export function f(ctx) { ctx.fail(${args}); }`, "f");
      } catch (error) {
        return error as DataError;
      }
      throw new Error("did not fail");
    };
    expect(
      failure(`"CONFLICT", "품절입니다.", { reason: "sold_out" }`),
    ).toMatchObject({
      status: 409,
      code: "CONFLICT",
      details: { reason: "sold_out" },
    });
    expect(failure(`"CONFLICT", "No."`).details).toBeUndefined();
    expect(failure(`"CONFLICT", "No.", "x".repeat(5000)`).message).toMatch(
      /4 KiB/,
    );
  });

  test("ctx.fail preserves the protocol code and message without invoking storage", () => {
    expect(() =>
      run(
        `export function reject(ctx) { ctx.fail("CONFLICT", "다른 곳에서 수정되었습니다."); }`,
        "reject",
      ),
    ).toThrow(
      expect.objectContaining({
        status: 409,
        code: "CONFLICT",
        message: "다른 곳에서 수정되었습니다.",
        // Written for the page's visitors; SDK 1.1.0 shows it as is.
        site: true,
      }),
    );
    expect(operations).toEqual([]);
  });

  test("code that throws is Naru's failure, not a message of the site's", () => {
    let thrown: unknown;
    try {
      run(
        `export function reject() { throw new Error("sold out"); }`,
        "reject",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { site?: boolean }).site).toBeUndefined();
  });

  test("a caught failure is terminal, including in queries", () => {
    expect(() =>
      run(
        `export async function reject(ctx) {
          try { ctx.fail("ACCESS_DENIED", "No access."); } catch {}
          try { await ctx.sql("SELECT 1"); } catch {}
          return { ok: true };
        }`,
        "reject",
        null,
        "query",
      ),
    ).toThrow(expect.objectContaining({ status: 403, code: "ACCESS_DENIED" }));
    expect(operations).toEqual([]);
  });

  test.each([
    ["custom_reason", "No."],
    ["CONFLICT", ""],
    ["CONFLICT", "   "],
    ["CONFLICT", 1],
    ["CONFLICT", "x".repeat(1001)],
  ])(
    "invalid ctx.fail arguments abort even when caught (%s)",
    (code, message) => {
      expect(() =>
        run(
          `export function reject(ctx, args) {
      try { ctx.fail(...args); } catch {}
      return true;
    }`,
          "reject",
          [code, message],
        ),
      ).toThrow(expect.objectContaining({ status: 400 }));
    },
  );

  test("undefined is null, and only own exports are functions", () => {
    expect(run("export function nothing() {}", "nothing")).toBeNull();
    for (const name of ["missing", "toString", "constructor", "__proto__"])
      expect(() => run("export const value = 1;", name)).toThrow(
        expect.objectContaining({ status: 404 }),
      );
    expect(() => run("export const value = 1;", "value")).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  test("the code's own failures are a 400 that says why, and which retire the instance", async () => {
    // Each case says whether it leaves the instance in doubt, so retires it.
    const cases: [string, RegExp, boolean][] = [
      [
        "export function f() { throw new Error('sold out'); }",
        /^Function failed: Error: sold out$/,
        false,
      ],
      [
        "export function f() { for (;;) {} }",
        /^Function failed: it ran too long\.$/,
        true,
      ],
      [
        "export function f() { const a = []; for (;;) a.push('x'.repeat(1e5) + a.length); }",
        /^Function failed: it used too much memory\.$/,
        true,
      ],
      [
        "export function f() { const g = () => g(); g(); }",
        /RangeError/,
        false,
      ],
      [
        "export async function f() { throw new Error('sold out'); }",
        /^Function failed: Error: sold out$/,
        false,
      ],
      [
        "export async function f() { await new Promise(() => {}); }",
        /never settles/,
        false,
      ],
      [
        "export async function f() { for (;;) await null; }",
        /^Function failed: it ran too long\.$/,
        true,
      ],
      // Small async steps each escape the interrupt check; they are counted too.
      [
        "export async function f() { for (;;) { for (let i = 0; i < 1000; i++); await null; } }",
        /^Function failed: it ran too long\.$/,
        true,
      ],
      // Work inside built-ins never reaches an interrupt check; the fuel
      // meter stops it all the same.
      [
        "export function f() { for (;;) JSON.parse('[1,2,3]'); }",
        /^Function failed: it ran too long\.$/,
        true,
      ],
      [
        "export function f() { const x = 'a'.repeat(1 << 17); for (;;) x.split('').reverse().join(''); }",
        /^Function failed: it ran too long\.$/,
        true,
      ],
      [
        "export function f() { return /(a+)+$/.test('a'.repeat(40) + 'b'); }",
        /^Function failed: it ran too long\.$/,
        true,
      ],
      ["export function f( {", /does not load/, false],
      [
        "export function f() { return 'x'.repeat(1024 * 1024 + 1); }",
        /1 MiB/,
        false,
      ],
    ];
    for (const [source, message, retires] of cases) {
      if (retired.has(module)) module = await engine();
      let error: DataError | undefined;
      try {
        run(source, "f");
      } catch (caught) {
        error = caught as DataError;
      }
      expect(error).toMatchObject({ status: 400 });
      expect(error!.message).toMatch(message);
      expect([source, retired.has(module)]).toEqual([source, retires]);
    }
  });

  test("a call spends fuel only within its budget, and a fresh instance runs after one is spent", async () => {
    const started = performance.now();
    expect(() =>
      run("export function f() { for (;;) JSON.parse('[1,2,3]'); }", "f"),
    ).toThrow(/it ran too long/);
    // A billion units is a few hundred milliseconds at most.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(retired.has(module)).toBe(true);
    module = await engine();
    expect(run("export function f() { return 1 + 1; }", "f")).toBe(2);
    expect(retired.has(module)).toBe(false);
  });

  test("a query or mutation's ctx holds who calls and sql, and nothing else", () => {
    const call = (source: string, kind: "query" | "mutation" | "route") =>
      runFunction(
        module,
        {
          source,
          name: "f",
          args: null,
          member: null,
          visitor: true,
          now: 1_700_000_000_000,
          kind,
          readonly: kind !== "mutation",
        },
        host,
      );
    for (const kind of ["query", "route"] as const)
      expect(
        call("export function f(ctx) { return Object.keys(ctx); }", kind),
      ).toEqual([
        "member",
        "owner",
        "ownerName",
        "visitor",
        "now",
        "fail",
        "sql",
        "rolesOf",
        "media",
        "passwords",
      ]);
    // A mutation may grant roles and notify members too.
    expect(
      call("export function f(ctx) { return Object.keys(ctx); }", "mutation"),
    ).toEqual([
      "member",
      "owner",
      "ownerName",
      "visitor",
      "now",
      "fail",
      "sql",
      "rolesOf",
      "media",
      "passwords",
      "setRoles",
      "notify",
    ]);
    // The caller's roles ride on ctx.member, frozen.
    expect(
      runFunction(
        module,
        {
          source:
            "export function f(ctx) { try { ctx.member.roles.push('owner'); } catch {} return ctx.member; }",
          name: "f",
          args: null,
          member: "m-1",
          now: 1,
          kind: "query",
          readonly: true,
          roles: ["staff"],
        },
        host,
      ),
    ).toEqual({ id: "m-1", roles: ["staff"] });
    // A query cannot grant roles, even through the host entry point.
    expect(() =>
      call(
        "export function f() { return __call('setRoles', 'm-2', ['staff']); }",
        "query",
      ),
    ).toThrow(/a query has no ctx.setRoles/);
    // Notifications go out only when something is written.
    expect(() =>
      call(
        "export function f() { return __call('notify', [], { title: 't' }); }",
        "query",
      ),
    ).toThrow(/a query has no ctx.notify/);
    // Nor reach anything but site SQL, whatever it asks the host.
    for (const operation of ["get", "add", "publish", "secretMatches"])
      expect(() =>
        call(
          `export function f() { return __call('${operation}', 'posts', '1'); }`,
          "mutation",
        ),
      ).toThrow(new RegExp(`a mutation has no ctx.${operation}`));
    expect(() =>
      call("export function f(ctx) { ctx.fail('NOT_FOUND', 'no'); }", "query"),
    ).toThrow(expect.objectContaining({ status: 404, message: "no" }));
  });

  test("a query's SQL is read-only whatever its code asks", () => {
    expect(() =>
      run(
        `export async function f(ctx) { await ctx.sql("UPDATE wallets SET balance = ? WHERE id = ?", [1, "m-1"]); }`,
        "f",
        null,
        "query",
      ),
    ).toThrow(/only reads/);
    expect(operations.at(-1)?.[1][2]).toBe(true);
    expect(wallets.size).toBe(0);
  });

  test("passwords are hashed by mutations, checked by both, a few a call", () => {
    expect(
      run(
        `export async function f(ctx) {
          const hash = await ctx.passwords.hash("1234");
          return [hash, await ctx.passwords.verify("1234", hash, "post-1"), await ctx.passwords.verify("0000", hash, "post-1")];
        }`,
        "f",
      ),
    ).toEqual(["hash:1234", true, false]);
    expect(
      run(
        "export function f(ctx) { return typeof ctx.passwords.hash; }",
        "f",
        null,
        "query",
      ),
    ).toBe("undefined");
    expect(() =>
      run(
        `export async function f(ctx) { for (;;) await ctx.passwords.verify("1", "hash:2", "k"); }`,
        "f",
        null,
        "query",
      ),
    ).toThrow(`more than ${MAX_PASSWORD_OPERATIONS} password operations`);
  });

  test("a call with no arguments gets undefined, so default parameters apply", () => {
    expect(
      run(
        "export function f(ctx, { board = 'free' } = {}) { return board; }",
        "f",
      ),
    ).toBe("free");
    expect(
      run("export function f(ctx, args) { return args; }", "f", { a: 1 }),
    ).toEqual({ a: 1 });
  });

  test("code can catch its own stack overflow and carry on", () => {
    expect(
      run(
        `export function f() {
          const g = (n) => g(n + 1);
          try { g(0); } catch (e) { return e.name; }
        }`,
        "f",
      ),
    ).toBe("RangeError");
  });

  test("the guest has URL and URLSearchParams, parsed as the host parses", () => {
    expect(
      run(
        `export function f() {
          const url = new URL("../b?x=1&y=a+b#top", "https://Example.com:443/a/c");
          url.searchParams.append("z", "c d");
          url.searchParams.set("x", "2");
          const copy = new URL(url);
          copy.hash = "";
          copy.pathname = "/other";
          return {
            href: url.href,
            origin: url.origin,
            host: url.host,
            y: url.searchParams.get("y"),
            all: [...new URLSearchParams({ a: 1, b: "x y" })].map((p) => p.join("=")),
            copy: copy.toString(),
            json: JSON.stringify({ url }),
            valid: [URL.canParse("https://x.test"), URL.canParse("nope"), URL.parse("nope")],
            invalid: (() => { try { new URL("javascript"); } catch (e) { return e.name; } })(),
          };
        }`,
        "f",
      ),
    ).toEqual({
      href: "https://example.com/b?x=2&y=a+b&z=c+d#top",
      origin: "https://example.com",
      host: "example.com",
      y: "a b",
      all: ["a=1", "b=x y"],
      copy: "https://example.com/other?x=2&y=a+b&z=c+d",
      json: '{"url":"https://example.com/b?x=2&y=a+b&z=c+d#top"}',
      valid: [true, false, null],
      invalid: "TypeError",
    });
    expect(() =>
      run(`export function f() { for (;;) new URL("https://x.test"); }`, "f"),
    ).toThrow(/more than 1000 URL operations/);
  });

  test("the guest sees no fetch, timers, or WebAssembly", () => {
    expect(
      run(
        `export function f() {
          return [typeof fetch, typeof setTimeout, typeof WebAssembly, typeof require, typeof process];
        }`,
        "f",
      ),
    ).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
    ]);
  });

  // What docs/sdk-v1-api.md ("The runtime's globals") and functions.d.ts
  // list: QuickJS's own, plus URL, URLSearchParams and structuredClone from
  // the prelude (Naru's `__` names aside).
  test("the guest's globals are the documented set", () => {
    const globals = run(
      `export function f() {
        return Object.getOwnPropertyNames(globalThis).filter((name) => !name.startsWith("__")).sort();
      }`,
      "f",
      null,
      "query",
    );
    expect(globals).toEqual(
      [
        // Values and functions
        "globalThis",
        "undefined",
        "NaN",
        "Infinity",
        "eval",
        "isFinite",
        "isNaN",
        "parseFloat",
        "parseInt",
        "decodeURI",
        "decodeURIComponent",
        "encodeURI",
        "encodeURIComponent",
        "escape",
        "unescape",
        "queueMicrotask",
        "structuredClone",
        // Objects and constructors
        "Object",
        "Function",
        "Array",
        "Number",
        "Boolean",
        "String",
        "Symbol",
        "BigInt",
        "Date",
        "RegExp",
        "JSON",
        "Math",
        "Reflect",
        "Proxy",
        "Promise",
        "Map",
        "Set",
        "WeakMap",
        "WeakSet",
        "WeakRef",
        "FinalizationRegistry",
        "Iterator",
        "ArrayBuffer",
        "SharedArrayBuffer",
        "DataView",
        "Int8Array",
        "Uint8Array",
        "Uint8ClampedArray",
        "Int16Array",
        "Uint16Array",
        "Int32Array",
        "Uint32Array",
        "BigInt64Array",
        "BigUint64Array",
        "Float16Array",
        "Float32Array",
        "Float64Array",
        "Error",
        "AggregateError",
        "EvalError",
        "InternalError",
        "RangeError",
        "ReferenceError",
        "SyntaxError",
        "TypeError",
        "URIError",
        "DOMException",
        "performance",
        "URL",
        "URLSearchParams",
      ].sort(),
    );
    // And what pages have that this does not.
    expect(
      run(
        `export function f() {
          return [typeof Intl, typeof TextEncoder, typeof TextDecoder, typeof crypto, typeof atob, typeof btoa, typeof console, typeof setTimeout, typeof performance.now, typeof Date.now()];
        }`,
        "f",
        null,
        "query",
      ),
    ).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "function",
      "number",
    ]);
  });

  test("structuredClone copies plain data, Dates, Maps, Sets and bytes, and refuses the rest", () => {
    expect(
      run(
        `export function f() {
          const shared = { n: 1 };
          const from = {
            list: [1, "two", null, shared, shared],
            when: new Date(5),
            map: new Map([["k", new Set([1, 2])]]),
            bytes: new Uint8Array([1, 2, 3]),
            pattern: /a+/gi,
          };
          from.self = from;
          const to = structuredClone(from);
          to.list[3].n = 2;
          to.bytes[0] = 9;
          const refused = [() => 1, Symbol("s"), new (class Thing {})(), new Int16Array(1)].map((value) => {
            try { structuredClone(value); return "cloned"; } catch (error) { return error.name; }
          });
          return {
            copied: to !== from && to.self === to && to.list[3] === to.list[4],
            untouched: [shared.n, from.bytes[0]],
            when: to.when instanceof Date && to.when.getTime(),
            map: [...to.map.get("k")],
            bytes: to.bytes instanceof Uint8Array && [...to.bytes],
            pattern: String(to.pattern),
            refused,
          };
        }`,
        "f",
        null,
        "query",
      ),
    ).toEqual({
      copied: true,
      untouched: [1, 1],
      when: 5,
      map: [1, 2],
      bytes: [9, 2, 3],
      pattern: "/a+/gi",
      refused: Array(4).fill("DataCloneError"),
    });
  });
});

describe("the host", () => {
  test("a failed ctx operation fails the call with the host's error, even if caught", () => {
    expect(() =>
      run(
        `export async function f(ctx) {
          try { await ctx.sql("INSERT INTO full VALUES (1)"); } catch {}
          return "carried on";
        }`,
        "f",
      ),
    ).toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED", status: 409 }));
  });

  test("every ctx result must be used, or the call fails", () => {
    const failure = (body: string) => {
      try {
        run(`export async function f(ctx) { ${body} }`, "f");
      } catch (error) {
        return (error as DataError).message;
      }
      return null;
    };
    expect(failure(`ctx.sql("SELECT 1"); return 1;`)).toBe(
      "Function failed: it did not await ctx.sql.",
    );
    expect(failure(`if (!ctx.rolesOf(["m1"])) return 1;`)).toBe(
      "Function failed: it did not await ctx.rolesOf.",
    );
    // The host's own failure explains more than the missing await.
    expect(() =>
      run(
        `export function f(ctx) { ctx.sql("INSERT INTO full VALUES (1)"); }`,
        "f",
      ),
    ).toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));
    // Awaiting, returning, chaining and Promise.all all count as use.
    for (const body of [
      `await ctx.sql("SELECT 1");`,
      `return ctx.sql("SELECT 1");`,
      `return ctx.sql("SELECT 1").then((result) => result.rows);`,
      `await ctx.sql("SELECT 1").catch(() => null);`,
      `await Promise.all([ctx.sql("SELECT 1"), ctx.rolesOf(["m1"])]);`,
      `const [a] = await Promise.allSettled([ctx.sql("SELECT 1")]); return a.status;`,
    ])
      expect(failure(body)).toBeNull();
    expect(
      run(
        `export function f(ctx) { const p = ctx.sql("SELECT 1"); return [p instanceof Promise, p.then(() => 1) instanceof Promise]; }`,
        "f",
      ),
    ).toEqual([true, true]);
  });

  test("operations are counted, since the interrupt checks cannot see them", () => {
    expect(() =>
      run(
        `export async function f(ctx) { for (let i = 0; ; i++) await ctx.sql("SELECT 1"); }`,
        "f",
      ),
    ).toThrow(`more than ${MAX_OPERATIONS} database operations`);
    expect(operations.length).toBe(MAX_OPERATIONS);
    operations = [];
    // Within the limits, everything goes through.
    expect(
      run(
        `export async function f(ctx) {
          for (let i = 0; i < ${MAX_OPERATIONS - 1}; i++)
            await ctx.sql("UPDATE wallets SET balance = ? WHERE id = ?", [i, "m-1"]);
          return (await ctx.sql\`SELECT balance FROM wallets WHERE id = \${"m-1"}\`).rows;
        }`,
        "f",
      ),
    ).toEqual([{ balance: MAX_OPERATIONS - 2 }]);
  });

  test("ctx is frozen, and nothing outlives a call", () => {
    expect(
      run(
        `export function f(ctx) { "use strict"; try { ctx.sql = null; } catch (e) { return e.name; } }`,
        "f",
      ),
    ).toBe("TypeError");
    const counter = `let n = 0; export function f() { globalThis.seen = (globalThis.seen ?? 0) + 1; return [++n, globalThis.seen]; }`;
    expect(run(counter, "f")).toEqual([1, 1]);
    expect(run(counter, "f")).toEqual([1, 1]);
  });
});

test("preloaded imports execute through the same ctx and read-only guard", () => {
  const filename = "mutations/shop.js";
  const source =
    'import { act } from "../modules/wallet.js"; export function buy(ctx) { return act(ctx); }';
  const modules = {
    [filename]: source,
    "modules/wallet.js":
      'export async function act(ctx) { await ctx.sql("UPDATE wallets SET balance = ? WHERE id = ?", [10, "one"]); return 1; }',
  };
  const invoke = (kind: "query" | "mutation") =>
    runFunction(
      module,
      {
        source,
        filename,
        modules,
        name: "buy",
        args: null,
        member: "m-1",
        now: 0,
        kind,
        readonly: kind === "query",
      },
      host,
    );
  expect(() => invoke("query")).toThrow(/only reads/);
  expect(wallets.size).toBe(0);
  expect(invoke("mutation")).toBe(1);
  expect(wallets.get("one")).toBe(10);
});

test("native cycles and re-exports retain live bindings, fresh for each call", () => {
  const filename = "queries/cycle.js";
  const source = 'export { read } from "../modules/a.js";';
  const modules = {
    [filename]: source,
    "modules/a.js":
      'import { increment } from "./b.js"; export let value = 1; export function read() { increment(); return value; } export function update() { value++; }',
    "modules/b.js":
      'import { update } from "./a.js"; export function increment() { update(); }',
  };
  const invoke = () =>
    runFunction(
      module,
      {
        source,
        filename,
        modules,
        name: "read",
        args: null,
        member: null,
        now: 0,
        kind: "query",
        readonly: true,
      },
      host,
    );
  expect(invoke()).toBe(2);
  expect(invoke()).toBe(2);
});

describe("ctx's owner name and media types", () => {
  const call = (
    source: string,
    kind: Invocation["kind"],
    extra: Partial<Invocation> = {},
  ) =>
    runFunction(
      module,
      {
        source,
        name: "f",
        args: null,
        member: "m-1",
        now: 1,
        kind,
        readonly: kind !== "mutation",
        ...extra,
      },
      host,
    );

  test("site code has the owner's name and the types Naru Media stores", () => {
    expect(
      call(
        `export function f(ctx) {
          return { owner: ctx.ownerName, pdf: ctx.media.types.includes("application/pdf") };
        }`,
        "query",
        { ownerName: "avocado" },
      ),
    ).toEqual({ owner: "avocado", pdf: true });
    // The media types cannot be changed by site code.
    expect(
      call(
        "export function f(ctx) { try { ctx.media.types.push('x'); } catch {} return ctx.media.types.length; }",
        "query",
      ),
    ).toBe(12);
  });
});
