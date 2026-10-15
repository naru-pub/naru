import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { ruleEntry, rulePredicate } from "./rules";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
  retired,
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
// Calls share an instance, so an ordinary call, failed or not, must leave it
// usable: only exhausting CPU or memory retires it (tested where it does).
afterEach(() => {
  expect(retired.has(module)).toBe(false);
});

test("one instance serves many calls, each freed before the next", () => {
  documents.set("wallets/m-1", { balance: 0 });
  // A megabyte a call, 100 MB in all: past the instance's 32 MiB unless freed.
  for (let n = 0; n < 100; n++)
    expect(
      run(
        `let calls = 0;
        export async function f(ctx) {
          const filler = "x".repeat(1 << 20);
          const wallet = await ctx.get("wallets", ctx.member.id);
          globalThis.leaked = filler;
          return [++calls, wallet.data.balance, filler.length];
        }`,
        "f",
      ),
    ).toEqual([1, 0, 1 << 20]);
  try {
    run(`export function f(ctx) { ctx.fail("CONFLICT", "No."); }`, "f");
  } catch {}
  try {
    run(`export async function f(ctx) { await ctx.set("full", "x", 1); }`, "f");
  } catch {}
});

describe("calling", () => {
  test("a function gets ctx and its arguments, and returns JSON", () => {
    documents.set("wallets/m-1", { balance: 150 });
    const result = run(
      `export async function buy(ctx, { item, price }) {
        const wallet = await ctx.get("wallets", ctx.member.id);
        if (wallet.data.balance < price) return { ok: false };
        await ctx.set("wallets", ctx.member.id, { balance: wallet.data.balance - price });
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

  test("ctx.owner says the site's owner called", () => {
    const source =
      "export function who(ctx) { return [ctx.owner, ctx.member]; }";
    expect(run(source, "who")).toEqual([false, { id: "m-1" }]);
    expect(
      runFunction(
        module,
        { source, name: "who", args: null, member: null, owner: true, now: 0 },
        host,
      ),
    ).toEqual([true, null]);
  });

  test("a visitor's call says so, hashes and checks passwords, and cannot delete uploads", () => {
    const visit = (source: string) =>
      runFunction(
        module,
        { source, name: "f", args: null, member: null, visitor: true, now: 0 },
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
    const [hash, right, wrong] = visit(`export function f(ctx) {
      const hash = ctx.password.hash("guest pass");
      return [hash, ctx.password.verify("guest pass", hash), ctx.password.verify("guess", hash)];
    }`) as [string, boolean, boolean];
    expect(hash).toMatch(/^pbkdf2-sha256\$20000\$/);
    expect([right, wrong]).toEqual([true, false]);
    expect(() =>
      visit(`export function f(ctx) { for (;;) ctx.password.hash("x"); }`),
    ).toThrow(/more than 3 password operations/);
    expect(() =>
      visit(
        `export function f(ctx) { ctx.password.verify("x", "not a hash"); }`,
      ),
    ).toThrow(/needs a hash from ctx.password.hash/);
    expect(() =>
      visit(
        `export async function f(ctx) { await ctx.media.delete("0190f1a2-0000-7000-8000-000000000001"); }`,
      ),
    ).toThrow(/cannot delete uploads/);
  });

  test("ctx.fail carries the function's details to the caller", () => {
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

  test("a function that throws is Naru's failure, not a message of the site's", () => {
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

  test("a caught failure is terminal, including in read-only functions", () => {
    expect(() =>
      runFunction(
        module,
        {
          source: `export async function reject(ctx) {
        try { ctx.fail("ACCESS_DENIED", "No access."); } catch {}
        try { await ctx.set("wallets", "x", 1); } catch {}
        return { ok: true };
      }`,
          name: "reject",
          args: null,
          member: "m-1",
          now: 0,
          readonly: true,
        },
        host,
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

  test("bulk read size and cumulative operations remain bounded", () => {
    const invoke = (source: string) =>
      runFunction(
        module,
        {
          source,
          name: "read",
          args: null,
          member: "m",
          now: 0,
          readonly: true,
        },
        () => [],
      );
    expect(
      invoke(
        `export function read(ctx) { return ctx.getMany("profiles", []); }`,
      ),
    ).toEqual([]);
    // A getMany of 100 IDs is one operation, as a list of 100 is.
    expect(
      invoke(
        `export async function read(ctx) { for (let i = 0; i < 100; i++) await ctx.getMany("profiles", Array(100).fill("a")); return null; }`,
      ),
    ).toBeNull();
    expect(() =>
      invoke(
        `export async function read(ctx) { for (let i = 0; i < 101; i++) await ctx.getMany("profiles", ["a"]); }`,
      ),
    ).toThrow(/more than 100 database operations/);
    expect(() =>
      invoke(
        `export async function read(ctx) { await ctx.getMany("profiles", Array(101).fill("a")); }`,
      ),
    ).toThrow(/at most 100 IDs/);
    expect(() =>
      invoke(
        `export async function read(ctx) { await ctx.getMany("profiles", "a"); }`,
      ),
    ).toThrow(/at most 100 IDs/);
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

  test("the function's own failures are a 400 that says why, and which retire the instance", async () => {
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
      ["export function f( {", /does not load/, false],
      ["export function f() { return 'x'.repeat(70000); }", /64 KiB/, false],
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
});

describe("the host", () => {
  test("a failed ctx operation fails the call with the host's error, even if caught", () => {
    expect(() =>
      run(
        `export async function f(ctx) {
          try { await ctx.set("full", "x", 1); } catch {}
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
    expect(failure(`ctx.set("c", "x", 1); return 1;`)).toBe(
      "Function failed: it did not await ctx.set.",
    );
    expect(failure(`if (!ctx.get("c", "x")) return 1;`)).toBe(
      "Function failed: it did not await ctx.get.",
    );
    // The host's own failure explains more than the missing await.
    expect(() =>
      run(`export function f(ctx) { ctx.set("full", "x", 1); }`, "f"),
    ).toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));
    // Awaiting, returning, chaining and Promise.all all count as use.
    for (const body of [
      `await ctx.get("c", "x");`,
      `return ctx.get("c", "x");`,
      `return ctx.get("c", "x").then((doc) => doc);`,
      `await ctx.get("c", "x").catch(() => null);`,
      `await Promise.all([ctx.get("c", "x"), ctx.list("c")]);`,
      `const [a] = await Promise.allSettled([ctx.get("c", "x")]); return a.status;`,
    ])
      expect(failure(body)).toBeNull();
    expect(
      run(
        `export function f(ctx) { const p = ctx.get("c", "x"); return [p instanceof Promise, p.then(() => 1) instanceof Promise]; }`,
        "f",
      ),
    ).toEqual([true, true]);
  });

  test("operations and writes are counted, since the interrupt checks cannot see them", () => {
    expect(() =>
      run(
        `export async function f(ctx) { for (let i = 0; ; i++) await ctx.get("c", "x"); }`,
        "f",
      ),
    ).toThrow(`more than ${MAX_OPERATIONS} database operations`);
    expect(operations.length).toBe(MAX_OPERATIONS);
    operations = [];
    expect(() =>
      run(
        `export async function f(ctx) { for (let i = 0; ; i++) await ctx.set("c", "x" + i, i); }`,
        "f",
      ),
    ).toThrow(`more than ${MAX_WRITES} writes`);
    expect(operations.length).toBe(MAX_WRITES);
    // Within the limits, everything goes through.
    expect(
      run(
        `export async function f(ctx) {
          for (let i = 0; i < ${MAX_WRITES}; i++) await ctx.set("c", "x" + i, i);
          return (await ctx.list("c", { size: 1 })).documents.length;
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
          source: `export async function read(ctx) { try { await ctx.${operation}("items", "one", {}); } catch {} return true; }`,
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

describe("community board rule example", () => {
  const modules = {
    "rules/community-board.js": readFileSync(
      new URL("../../docs/examples/community-board-rules.js", import.meta.url),
      "utf8",
    ),
  };
  const invoke = (name: string, args: unknown, member: string | null = "m-1") =>
    runFunction(
      module,
      {
        ...ruleEntry("rules/community-board.js"),
        modules,
        name,
        args,
        member,
        now: 1,
        readonly: true,
      },
      host,
    );
  // The write hook answers true, or what canWrite gave instead.
  const allowed = (args: unknown) => invoke("__naruWrite", args) === true;
  const log = {
    id: "log",
    createdBy: "m-1",
    data: {
      owner: "m-1",
      board: "default",
      secret: true,
      title: "Secret",
      category: "",
      text: "body",
      image: "https://example.com/a.png",
    },
  };
  test("board read/list levels produce restrictive SQL and anonymous access is denied", () => {
    documents.set("neo_avocado_boards/default", { listLevel: 3, readLevel: 2 });
    expect(
      invoke("__naruScope", {
        collection: "neo_avocado_logs",
        operation: "list",
        filter: { board: "default" },
      }),
    ).toBe(false);
    expect(
      invoke(
        "__naruScope",
        { collection: "neo_avocado_logs", operation: "list", filter: {} },
        null,
      ),
    ).toBe(false);
    documents.set("neo_avocado_boards/default", { listLevel: 2, readLevel: 2 });
    const predicate = invoke("__naruScope", {
      collection: "neo_avocado_logs",
      operation: "list",
      filter: { board: "default" },
    });
    expect(rulePredicate(predicate).bindings).toContain("m-1");
  });
  test("write ownership, required secrets, board changes and direct cascade deletion are checked", () => {
    documents.set("neo_avocado_boards/default", {
      writeLevel: 2,
      secret: "required",
      kind: "image",
    });
    const write = (before: unknown, after: unknown, operation = "update") =>
      allowed({
        collection: "neo_avocado_logs",
        before,
        after,
        operation,
      });
    expect(write(null, log, "create")).toBe(true);
    expect(write(log, { ...log, data: { ...log.data, owner: "other" } })).toBe(
      false,
    );
    expect(write(log, { ...log, data: { ...log.data, board: "other" } })).toBe(
      false,
    );
    expect(write(log, { ...log, data: { ...log.data, secret: false } })).toBe(
      false,
    );
    expect(write(log, null, "delete")).toBe(false);
    expect(write({ ...log, createdBy: "other" }, log)).toBe(false);
    documents.set("neo_avocado_members/m-1", { role: "moderator", level: 10 });
    const other = {
      ...log,
      createdBy: "other",
      data: { ...log.data, owner: "other" },
    };
    expect(write(other, other)).toBe(true);
  });
  test("comments require readable parents, enforce comment levels and reject parent forgery", () => {
    documents.set("neo_avocado_logs/log", { ...log.data, owner: "other" });
    const args = {
      collection: "neo_avocado_comments",
      operation: "list",
      filter: { logId: "log" },
    };
    expect(invoke("__naruScope", args)).toBe(false);
    documents.set("neo_avocado_logs/log", log.data);
    expect(invoke("__naruScope", args)).toEqual({ eq: ["logId", "log"] });
    const comment = {
      id: "comment",
      createdBy: "m-1",
      data: { owner: "m-1", logId: "log", text: "hi", dice: false },
    };
    documents.set("neo_avocado_boards/default", {
      readLevel: 2,
      commentLevel: 3,
    });
    expect(
      allowed({
        collection: "neo_avocado_comments",
        operation: "create",
        before: null,
        after: comment,
      }),
    ).toBe(false);
    documents.set("neo_avocado_boards/default", {
      readLevel: 2,
      commentLevel: 2,
    });
    expect(
      allowed({
        collection: "neo_avocado_comments",
        operation: "create",
        before: null,
        after: comment,
      }),
    ).toBe(true);
    expect(
      allowed({
        collection: "neo_avocado_comments",
        operation: "update",
        before: comment,
        after: { ...comment, data: { ...comment.data, logId: "other" } },
      }),
    ).toBe(false);
  });
});

test("preloaded imports execute through the same ctx and read-only guard", () => {
  const filename = "functions/shop.js";
  const source =
    'import { act } from "../modules/wallet.js"; export function buy(ctx) { return act(ctx); }';
  const modules = {
    [filename]: source,
    "modules/wallet.js":
      'export async function act(ctx) { try { await ctx.set("wallets", "one", 10); } catch {} return 1; }',
  };
  expect(() =>
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
        readonly: true,
      },
      host,
    ),
  ).toThrow("read-only functions cannot write");
  expect(documents.size).toBe(0);
  expect(
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
      },
      host,
    ),
  ).toBe(1);
  expect(documents.get("wallets/one")).toBe(10);
});

test("native cycles and re-exports retain live bindings, fresh for each call", () => {
  const filename = "functions/cycle.js";
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
      },
      host,
    );
  expect(invoke()).toBe(2);
  expect(invoke()).toBe(2);
});
