import { parse, type Node } from "acorn";
import { DataError } from "../site-data/validation";

export const MAX_MODULES = 64;
export const MAX_MODULE_BYTES = 256 * 1024;
export const MAX_GRAPH_BYTES = 1024 * 1024;
export type ModuleSources = Record<string, string>;
const invalid = (message: string) =>
  new DataError(400, `Function modules: ${message}`);

/**
 * Canonical paths below _naru. Import-only modules cannot be called as RPCs;
 * collection rules are their own entry points; queries and mutations (1.1.0)
 * are called by name like functions.
 */
export function modulePath(value: string): string {
  const parts = value.split("/");
  if (
    !["functions", "modules", "rules", "queries", "mutations"].includes(
      parts[0],
    ) ||
    parts.length < 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]{1,128}$/.test(part) || part === "." || part === "..",
    ) ||
    !/\.m?js$/.test(parts.at(-1)!)
  )
    throw invalid(`invalid path ${value}.`);
  return value;
}
export function resolveModule(base: string, specifier: string): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../"))
    throw invalid("imports must use relative paths.");
  if (/[\\%?#:]/.test(specifier)) throw invalid(`invalid import ${specifier}.`);
  const parts = base.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw invalid("import escapes _naru.");
      parts.pop();
    } else {
      if (!part) throw invalid("empty import segment.");
      parts.push(part);
    }
  }
  const resolved = modulePath(parts.join("/"));
  // Rules may share modules; functions and modules never import a rule.
  if (resolved.startsWith("rules/") && !base.startsWith("rules/"))
    throw invalid("only collection rules may import from _naru/rules.");
  return resolved;
}

export function moduleImports(source: string, filename: string): string[] {
  let tree: Node;
  try {
    tree = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw invalid(
      `${filename}: ${error instanceof Error ? error.message : "invalid JavaScript"}`,
    );
  }
  const imports: string[] = [];
  const visit = (node: Node, inFunction = false) => {
    const value = node as Node & Record<string, unknown>;
    if (node.type === "ImportExpression")
      throw invalid("dynamic imports are not supported.");
    if (
      (node.type === "AwaitExpression" ||
        (node.type === "ForOfStatement" && value.await)) &&
      !inFunction
    )
      throw invalid("top-level await is not supported.");
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
      ].includes(node.type) &&
      value.source
    ) {
      const specifier = (value.source as { value: unknown }).value;
      if (typeof specifier !== "string")
        throw invalid("invalid import specifier.");
      imports.push(resolveModule(filename, specifier));
    }
    const nested =
      inFunction ||
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(node.type);
    for (const field of Object.values(value)) {
      if (Array.isArray(field))
        for (const child of field) {
          if (child && typeof child === "object" && "type" in child)
            visit(child as Node, nested);
        }
      else if (field && typeof field === "object" && "type" in field)
        visit(field as Node, nested);
    }
  };
  visit(tree);
  return [...new Set(imports)];
}

/**
 * The exports a functions module lists in `export const <list> = ["name", ...]`,
 * string literals only, so publishing can read them without running anything:
 * `readOnly`, whose calls run with writes forbidden on the read budget, and
 * `visitors`, which visitors may call without signing in.
 */
export function declaredExports(
  source: string,
  filename: string,
  list: "readOnly" | "visitors",
): string[] {
  let tree: Node;
  try {
    tree = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw invalid(
      `${filename}: ${error instanceof Error ? error.message : "invalid JavaScript"}`,
    );
  }
  const wrong = () =>
    invalid(
      `${filename}: declare these as export const ${list} = ["name", ...].`,
    );
  let names: string[] = [];
  for (const statement of (tree as unknown as { body: Node[] }).body) {
    const node = statement as Node & Record<string, unknown>;
    if (node.type !== "ExportNamedDeclaration") continue;
    for (const specifier of (node.specifiers ?? []) as {
      exported: { name?: string; value?: string };
    }[])
      if ((specifier.exported.name ?? specifier.exported.value) === list)
        throw wrong();
    const declaration = node.declaration as
      (Node & Record<string, unknown>) | null;
    if (!declaration) continue;
    if (declaration.type !== "VariableDeclaration") {
      if ((declaration.id as { name?: string } | null)?.name === list)
        throw wrong();
      continue;
    }
    for (const declarator of declaration.declarations as {
      id: { type: string; name?: string };
      init: (Node & Record<string, unknown>) | null;
    }[]) {
      if (declarator.id.type !== "Identifier") {
        if (JSON.stringify(declarator.id).includes(`"${list}"`)) throw wrong();
        continue;
      }
      if (declarator.id.name !== list) continue;
      const init = declarator.init;
      if (
        declaration.kind !== "const" ||
        init?.type !== "ArrayExpression" ||
        (init.elements as ({ type: string; value?: unknown } | null)[]).some(
          (element) =>
            element?.type !== "Literal" ||
            typeof element.value !== "string" ||
            !/^[a-zA-Z0-9_-]{1,64}$/.test(element.value),
        )
      )
        throw wrong();
      names = (init.elements as { value: string }[]).map(
        (element) => element.value,
      );
    }
  }
  return [...new Set(names)];
}

export const readOnlyExports = (source: string, filename: string) =>
  declaredExports(source, filename, "readOnly");

/** Storage I/O finishes before QuickJS and the synchronous SQLite transaction. */
export async function loadModuleGraph(
  entry: string,
  read: (path: string) => Promise<string | null>,
  dependencies = moduleImports,
): Promise<ModuleSources> {
  modulePath(entry);
  const sources: ModuleSources = Object.create(null);
  const scheduled = new Set([entry]);
  let queue = [entry],
    bytes = 0;
  while (queue.length) {
    const batch = queue;
    queue = [];
    const files = await Promise.all(
      batch.map(async (filename) => ({
        filename,
        source: await read(filename),
      })),
    );
    for (const { filename, source } of files) {
      if (source === null)
        throw new DataError(404, `No function module ${filename}.`);
      const size = new TextEncoder().encode(source).byteLength;
      if (size > MAX_MODULE_BYTES)
        throw invalid(`${filename} exceeds 256 KiB.`);
      bytes += size;
      if (bytes > MAX_GRAPH_BYTES) throw invalid("module graph exceeds 1 MiB.");
      sources[filename] = source;
      for (const dependency of dependencies(source, filename))
        if (!scheduled.has(dependency)) {
          scheduled.add(dependency);
          if (scheduled.size > MAX_MODULES)
            throw invalid("module graph exceeds 64 files.");
          queue.push(dependency);
        }
    }
  }
  return sources;
}
