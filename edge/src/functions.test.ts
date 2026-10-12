import { beforeEach, describe, expect, test } from "vitest";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
import { DataError } from "../../control-plane/src/lib/site-data/validation";
import {
  MAX_OPERATIONS,
  MAX_WRITES,
  runFunction,
  type Host,
  type Invocation,
} from "./functions";

// The engine in plain Node, with the same QuickJS build and memory cap as the
// Worker (quickjs.ts) and an in-memory host standing in for the site's object.
const engine = () =>
  newQuickJSWASMModuleFromVariant(
    newVariant(variant, {
      wasmMemory: () =>
        Promise.resolve(new WebAssembly.Memory({ initial: 256, maximum: 512 })),
    }),
  );

let module: QuickJSWASMModule;
let documents: Map<string, unknown>;
let operations: [string, unknown[]][];
const host: Host = (operation, args) => {
  operations.push([operation, args]);
  const key = `${args[0]}/${args[1]}`;
  switch (operation) {
    case "random":
      return 0.5;
    case "get":
      return documents.has(key)
        ? { id: args[1], data: documents.get(key) }
        : null;
    case "set":
      if (args[0] === "full")
        throw new DataError(
          409,
          "Site database quota exceeded.",
          "QUOTA_EXCEEDED",
        );
      documents.set(key, args[2]);
      return { id: args[1], data: args[2] };
    case "add":
      documents.set(`${args[0]}/new`, args[1]);
      return { id: "new", data: args[1] };
    case "list":
      return { documents: [], nextCursor: null };
    case "delete":
      documents.delete(key);
      return null;
    default:
      throw new DataError(400, `ctx has no ${operation}.`);
  }
};
const run = (source: string, name: string, args: unknown = null) =>
  runFunction(
    module,
    { source, name, args, member: "m-1", now: 1_700_000_000_000 } as Invocation,
    host,
  );

beforeEach(async () => {
  module = await engine();
  documents = new Map();
  operations = [];
});

describe("calling", () => {
  test("a function gets ctx and its arguments, and returns JSON", () => {
    documents.set("wallets/m-1", { balance: 150 });
    const result = run(
      `export function buy(ctx, { item, price }) {
        const wallet = ctx.get("wallets", ctx.member.id);
        if (wallet.data.balance < price) return { ok: false };
        ctx.set("wallets", ctx.member.id, { balance: wallet.data.balance - price });
        return { ok: true, item, at: ctx.now, roll: ctx.random(), math: Math.random() };
      }`,
      "buy",
      { item: "sword", price: 100 },
    );
    expect(result).toEqual({
      ok: true,
      item: "sword",
      at: 1_700_000_000_000,
      roll: 0.5,
      math: 0.5,
    });
    expect(documents.get("wallets/m-1")).toEqual({ balance: 50 });
  });

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

  test("the function's own failures are a 400 that says why", () => {
    const failure = (source: string) => {
      try {
        run(source, "f");
      } catch (error) {
        return error as DataError;
      }
      throw new Error("did not fail");
    };
    expect(
      failure("export function f() { throw new Error('sold out'); }"),
    ).toMatchObject({
      status: 400,
      message: "Function failed: Error: sold out",
    });
    expect(failure("export function f() { for (;;) {} }").message).toBe(
      "Function failed: it ran too long.",
    );
    expect(
      failure(
        "export function f() { const a = []; for (;;) a.push('x'.repeat(1e5) + a.length); }",
      ).message,
    ).toBe("Function failed: it used too much memory.");
    expect(
      failure("export function f() { const g = () => g(); g(); }").message,
    ).toMatch(/RangeError/);
    expect(failure("export async function f() { return 1; }").message).toMatch(
      /synchronous/,
    );
    expect(failure("export function f( {").message).toMatch(/does not load/);
    expect(
      failure("export function f() { return 'x'.repeat(70000); }").message,
    ).toMatch(/64 KiB/);
  });

  test("a function can catch its own stack overflow and carry on", () => {
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
});

describe("the host", () => {
  test("a failed ctx operation fails the call with the host's error, even if caught", () => {
    expect(() =>
      run(
        `export function f(ctx) {
          try { ctx.set("full", "x", 1); } catch {}
          return "carried on";
        }`,
        "f",
      ),
    ).toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED", status: 409 }));
  });

  test("operations and writes are counted, since the interrupt checks cannot see them", () => {
    expect(() =>
      run(
        `export function f(ctx) { for (let i = 0; ; i++) ctx.get("c", "x"); }`,
        "f",
      ),
    ).toThrow(`more than ${MAX_OPERATIONS} database operations`);
    expect(operations.length).toBe(MAX_OPERATIONS);
    operations = [];
    expect(() =>
      run(
        `export function f(ctx) { for (let i = 0; ; i++) ctx.set("c", "x" + i, i); }`,
        "f",
      ),
    ).toThrow(`more than ${MAX_WRITES} writes`);
    expect(operations.length).toBe(MAX_WRITES);
    // Within the limits, everything goes through.
    expect(
      run(
        `export function f(ctx) {
          for (let i = 0; i < ${MAX_WRITES}; i++) ctx.set("c", "x" + i, i);
          return ctx.list("c", { size: 1 }).documents.length;
        }`,
        "f",
      ),
    ).toBe(0);
  });

  test("ctx is frozen, and nothing outlives a call", () => {
    expect(
      run(
        `export function f(ctx) { "use strict"; try { ctx.get = null; } catch (e) { return e.name; } }`,
        "f",
      ),
    ).toBe("TypeError");
    const counter = `let n = 0; export function f() { globalThis.seen = (globalThis.seen ?? 0) + 1; return [++n, globalThis.seen]; }`;
    expect(run(counter, "f")).toEqual([1, 1]);
    expect(run(counter, "f")).toEqual([1, 1]);
  });
});

test("read-only execution rejects every write even when caught", () => {
  for (const operation of ["add", "set", "delete"]) {
    expect(() =>
      runFunction(
        module,
        {
          source: `export function read(ctx) { try { ctx.${operation}("items", "one", {}); } catch {} return true; }`,
          name: "read",
          args: null,
          member: "m-1",
          now: 0,
          readonly: true,
        },
        host,
      ),
    ).toThrow("read-only functions cannot write");
  }
  expect(operations).toEqual([]);
  expect(documents.size).toBe(0);
});
test("read-only execution permits reads", () => {
  documents.set("items/one", { value: 1 });
  expect(
    runFunction(
      module,
      {
        source: 'export function read(ctx) { return ctx.get("items", "one"); }',
        name: "read",
        args: null,
        member: "m-1",
        now: 0,
        readonly: true,
      },
      host,
    ),
  ).toEqual({ id: "one", data: { value: 1 } });
});
