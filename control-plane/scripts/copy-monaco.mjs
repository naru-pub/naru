// Copies Monaco's browser build into public/monaco-editor/vs, where the file
// manager's editor loads it from (see useOpenFiles.ts). Loaded from jsdelivr,
// it failed whenever the CDN was slow or blocked for a visitor, and its
// workers had to be started from blobs that import the CDN's scripts.
//
// `pnpm dev` and `pnpm build` run it first, so the copy is always the
// installed monaco-editor; it is not committed.
import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// The package's "require" entry is min/vs/editor/editor.main.js.
const vs = join(dirname(require.resolve("monaco-editor")), "..");
const target = join(root, "public/monaco-editor/vs");

await rm(target, { recursive: true, force: true });
await cp(vs, target, { recursive: true });
