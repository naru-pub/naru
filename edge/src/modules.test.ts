import { describe, expect, test } from "vitest";
import {
  loadModuleGraph,
  moduleImports,
  resolveModule,
  modulePath,
  MAX_MODULES,
} from "./modules";
describe("static site imports", () => {
  test("resolves siblings and private modules within _naru", () => {
    expect(
      resolveModule("mutations/shop/buy.js", "../../modules/wallet.js"),
    ).toBe("modules/wallet.js");
    expect(resolveModule("mutations/shop.js", "./shared.js")).toBe(
      "mutations/shared.js",
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
    expect(() => resolveModule("mutations/shop.js", value)).toThrow(),
  );
  test("site code lives in modules, queries, mutations and routes.js alone", () => {
    expect(resolveModule("queries/shop.js", "../modules/x.mjs")).toBe(
      "modules/x.mjs",
    );
    expect(resolveModule("routes.js", "./modules/x.js")).toBe("modules/x.js");
    expect(modulePath("routes.js")).toBe("routes.js");
    for (const path of [
      "functions/shop.js",
      "rules/shop.js",
      "routes/x.js",
      "other.js",
    ])
      expect(() => modulePath(path)).toThrow(/invalid path/);
  });
  test("discovers imports and reexports without treating strings/comments as imports", () => {
    expect(
      moduleImports(
        'import {x} from "../modules/x.js"; export * from "./other.js"; const s="import(123)"; // import("x")',
        "mutations/shop.js",
      ),
    ).toEqual(["modules/x.js", "mutations/other.js"]);
  });
  test.each([
    'export function x() { return import("./x.js"); }',
    "await 1;",
    "for await (const value of []) {}",
    'import {x} from "node:fs";',
  ])("rejects unsupported module code", (source) =>
    expect(() => moduleImports(source, "mutations/shop.js")).toThrow(),
  );
  test("loads a cyclic graph once and finishes storage reads before execution", async () => {
    const files: Record<string, string> = {
      "mutations/a.js": 'export { b } from "../modules/b.js";',
      "modules/b.js":
        'import "../mutations/a.js"; export function b() {return 1;}',
    };
    const reads: string[] = [];
    expect(
      await loadModuleGraph("mutations/a.js", async (path) => {
        reads.push(path);
        return files[path] ?? null;
      }),
    ).toEqual(files);
    expect(reads).toEqual(["mutations/a.js", "modules/b.js"]);
  });
  test("missing imports and oversized graphs fail before any execution", async () => {
    await expect(
      loadModuleGraph("mutations/a.js", async (path) =>
        path.endsWith("a.js") ? 'import "./missing.js";' : null,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      loadModuleGraph("mutations/a.js", async () => " ".repeat(256 * 1024 + 1)),
    ).rejects.toThrow("256 KiB");
    await expect(
      loadModuleGraph(
        "mutations/0.js",
        async (path) => `import "./${Number(path.match(/\d+/)![0]) + 1}.js";`,
      ),
    ).rejects.toThrow(`${MAX_MODULES} files`);
  });
});
