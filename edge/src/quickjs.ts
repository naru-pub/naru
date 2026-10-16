import type { QuickJSWASMModule } from "quickjs-emscripten-core";
// Bundled by wrangler as a compiled WebAssembly.Module.
import wasmModule from "../quickjs/metered.wasm";
import { newEngine } from "./engine";
import { retired } from "./functions";

// The QuickJS instance site functions run in (functions.ts), metered and
// memory-capped (engine.ts).
//
// One instance serves every call in this isolate, whichever site's object
// makes it: a call runs synchronously from its runtime's creation to its
// disposal, so calls never overlap, and starting an instance is most of a
// fresh call's cost. Sharing also keeps one instance's memory resident per
// isolate rather than one per busy site. An instance a call retired is
// replaced, and so is one that has served CALLS_PER_INSTANCE calls, so that
// whatever freeing leaves behind in its memory cannot accumulate for long.
const CALLS_PER_INSTANCE = 1000;

let current: Promise<QuickJSWASMModule> | undefined;
let calls = 0;

function create() {
  return newEngine(wasmModule);
}

/** The instance to run the next call in: run it before awaiting anything else. */
export async function quickjs(): Promise<QuickJSWASMModule> {
  for (;;) {
    const pending = (current ??= create());
    let module: QuickJSWASMModule;
    try {
      module = await pending;
    } catch (error) {
      if (current === pending) current = undefined;
      throw error;
    }
    if (!retired.has(module) && calls < CALLS_PER_INSTANCE) {
      calls++;
      return module;
    }
    if (current === pending) {
      current = undefined;
      calls = 0;
    }
  }
}
