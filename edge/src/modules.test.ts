import { describe, expect, test } from "vitest";
import {
  loadModuleGraph,
  moduleImports,
  resolveModule,
  MAX_MODULES,
} from "./modules";
describe("static site imports", () => {
  test("resolves siblings and private modules within _naru", () => {
    expect(
      resolveModule("functions/shop/buy.js", "../../modules/wallet.js"),
    ).toBe("modules/wallet.js");
    expect(resolveModule("functions/shop.js", "./shared.js")).toBe(
      "functions/shared.js",
    );
  });
  test.each([
    "../../../secret.js",
    "https://example.com/x.js",
    "acorn",
    "/modules/x.js",
    "./%2e%2e/x.js",
    "./x.js?v=1",
    "./x\\y.js",
    "../rules/auth.js",
  ])("rejects %s", (value) =>
    expect(() => resolveModule("functions/shop.js", value)).toThrow(),
  );
  test("rules import shared modules and other rules, nothing imports a rule", () => {
    expect(resolveModule("rules/board.js", "../modules/shared.js")).toBe(
      "modules/shared.js",
    );
    expect(resolveModule("rules/:naru", "./board.js")).toBe("rules/board.js");
    expect(resolveModule("functions/shop.js", "../modules/x.mjs")).toBe(
      "modules/x.mjs",
    );
    expect(() =>
      resolveModule("modules/shared.js", "../rules/board.js"),
    ).toThrow(/only collection rules/);
  });
  test("discovers imports and reexports without treating strings/comments as imports", () => {
    expect(
      moduleImports(
        'import {x} from "../modules/x.js"; export * from "./other.js"; const s="import(123)"; // import("x")',
        "functions/shop.js",
      ),
    ).toEqual(["modules/x.js", "functions/other.js"]);
  });
  test.each([
    'export function x() { return import("./x.js"); }',
    "await 1;",
    "for await (const value of []) {}",
    'import {x} from "node:fs";',
  ])("rejects unsupported module code", (source) =>
    expect(() => moduleImports(source, "functions/shop.js")).toThrow(),
  );
  test("loads a cyclic graph once and finishes storage reads before execution", async () => {
    const files: Record<string, string> = {
      "functions/a.js": 'export { b } from "../modules/b.js";',
      "modules/b.js":
        'import "../functions/a.js"; export function b() {return 1;}',
    };
    const reads: string[] = [];
    expect(
      await loadModuleGraph("functions/a.js", async (path) => {
        reads.push(path);
        return files[path] ?? null;
      }),
    ).toEqual(files);
    expect(reads).toEqual(["functions/a.js", "modules/b.js"]);
  });
  test("missing imports and oversized graphs fail before any execution", async () => {
    await expect(
      loadModuleGraph("functions/a.js", async (path) =>
        path.endsWith("a.js") ? 'import "./missing.js";' : null,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      loadModuleGraph("functions/a.js", async () => " ".repeat(256 * 1024 + 1)),
    ).rejects.toThrow("256 KiB");
    await expect(
      loadModuleGraph(
        "functions/0.js",
        async (path) => `import "./${Number(path.match(/\d+/)![0]) + 1}.js";`,
      ),
    ).rejects.toThrow(`${MAX_MODULES} files`);
  });
});
