// Emits each SDK version's naru.js and naru.d.ts from sdk/<version>/naru.ts.
// Run `pnpm sdk:build` after editing the source and commit what it writes;
// `pnpm sdk:check` (which `pnpm build` runs first) fails instead of writing
// when the committed files are not what the source emits now.
//
// The emitted files are the SDK: they are what tests import, what naru.pub
// serves, and what a site may have cached or copied. Nothing regenerates them
// at deploy time, so a compiler or formatter upgrade can change them only in a
// commit that shows the change. A version that has been frozen is removed from
// VERSIONS below rather than re-emitted.
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSIONS = ["1.1.0"];
const check = process.argv.includes("--check");

// The SDK is one browser module with no dependencies, so it is compiled on its
// own terms rather than through the application's tsconfig: modern syntax is
// kept as written, and only the type annotations come out.
const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  types: [],
  strict: true,
  declaration: true,
  removeComments: false,
  newLine: ts.NewLineKind.LineFeed,
  noEmitOnError: true,
};

function emit(source) {
  const program = ts.createProgram([source], options);
  const files = new Map();
  const { diagnostics, emitSkipped } = program.emit(undefined, (name, text) =>
    files.set(basename(name), text),
  );
  const problems = [...ts.getPreEmitDiagnostics(program), ...diagnostics];
  if (problems.length || emitSkipped)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(problems, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }) || `TypeScript emitted nothing for ${source}`,
    );
  return files;
}

// TypeScript prints declarations with no blank lines between them and every
// type literal spread over several lines, which prettier would keep. The files
// are read by people, so they get the source's paragraphs back: a declaration
// has a blank line before it where the source had one before it or before a
// declaration that was compiled away in between, and a declaration file's
// type literals are collapsed where they fit.
const declared = (statement) =>
  ts.isVariableStatement(statement)
    ? statement.declarationList.declarations[0]?.name.getText()
    : statement.name?.getText();
const blankBefore = (file, statement) =>
  /\n[ \t]*\n/.test(
    file.text.slice(statement.getFullStart(), statement.getStart(file, true)),
  );
const parse = (name, text) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);

async function readable(name, text, source) {
  const collapsed = await format(text, {
    filepath: name,
    objectWrap: name.endsWith(".d.ts") ? "collapse" : "preserve",
  });
  const output = parse(name, collapsed);
  const kept = new Set(output.statements.map(declared));
  const paragraphs = new Set();
  let pending = false;
  for (const statement of source.statements) {
    pending ||= blankBefore(source, statement);
    const name = declared(statement);
    if (!kept.has(name)) continue;
    if (pending) paragraphs.add(name);
    pending = false;
  }
  // `export {}` has no name and ends the file on its own; the file comment
  // stands apart from the first declaration's.
  const breaks = output.statements
    .slice(1)
    .filter((statement) => {
      const name = declared(statement);
      return name === undefined || paragraphs.has(name);
    })
    .map((statement) => statement.getFullStart());
  const header = ts.getLeadingCommentRanges(collapsed, 0)?.[0];
  if (
    header &&
    collapsed.slice(header.pos, header.end).includes("@packageDocumentation")
  )
    breaks.push(header.end);
  let spaced = collapsed;
  for (const at of breaks.sort((a, b) => b - a))
    spaced = `${spaced.slice(0, at)}\n${spaced.slice(at)}`;
  return format(spaced, { filepath: name });
}

let stale = false;
for (const version of VERSIONS) {
  const source = join(root, "sdk", version, "naru.ts");
  const emitted = emit(source);
  const parsed = parse(source, await readFile(source, "utf8"));
  for (const name of ["naru.js", "naru.d.ts"]) {
    const output = join(root, "public", "sdk", version, name);
    const text = emitted.get(name);
    if (text === undefined) throw new Error(`No ${name} was emitted.`);
    const contents = await readable(output, text, parsed);
    const existing = await readFile(output, "utf8").catch(() => null);
    const path = relative(root, output);
    if (existing === contents) {
      console.log(`sdk:${check ? "check" : "build"} ${path}: up to date`);
      continue;
    }
    if (check) {
      stale = true;
      console.error(`${path} is not what sdk/${version}/naru.ts emits.`);
      continue;
    }
    await writeFile(output, contents);
    console.log(`sdk:build ${path}: written`);
  }
}
if (stale) {
  console.error("Run `pnpm sdk:build` and commit the result.");
  process.exit(1);
}
