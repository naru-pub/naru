import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
// Bundled by wrangler as a compiled WebAssembly.Module.
import wasmModule from "../node_modules/@jitl/quickjs-ng-wasmfile-release-sync/dist/emscripten-module.wasm";

// One QuickJS instance for one function call (functions.ts). Its memory is a
// WebAssembly.Memory of at most 32 MiB, which the engine enforces where
// QuickJS's own memory limit does not; the module needs 16 MiB to start.
const PAGES = { initial: 256, maximum: 512 };

export function quickjs(): Promise<QuickJSWASMModule> {
  return newQuickJSWASMModuleFromVariant(
    newVariant(variant, {
      wasmModule,
      wasmMemory: () => Promise.resolve(new WebAssembly.Memory(PAGES)),
    }),
  );
}
