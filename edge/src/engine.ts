import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";

// A QuickJS instance for site code, from the metered build of the variant's
// WebAssembly (quickjs/metered.wasm, made by quickjs/meter). The meter charges
// an exported counter, `naru_fuel`, at every function entry and loop
// iteration inside the engine, built-ins included, and traps once it goes
// below zero: a call's CPU is bounded wherever its time goes, where QuickJS's
// own interrupt checks miss work done in built-ins (a regular expression,
// String.prototype.split, JSON.parse).
//
// Its memory is a WebAssembly.Memory of at most 32 MiB, which the engine
// enforces where QuickJS's own memory limit does not; the module needs 16 MiB
// to start.
const PAGES = { initial: 256, maximum: 512 };

/** Each instance's fuel counter, set before a call (functions.ts). */
export const fuel = new WeakMap<QuickJSWASMModule, WebAssembly.Global>();

/** A new QuickJS instance of `wasmModule`, the metered build. */
export async function newEngine(
  wasmModule: WebAssembly.Module,
): Promise<QuickJSWASMModule> {
  let counter: WebAssembly.Global | undefined;
  const module = await newQuickJSWASMModuleFromVariant(
    newVariant(variant, {
      wasmMemory: () => Promise.resolve(new WebAssembly.Memory(PAGES)),
      emscriptenModule: {
        // Instantiated here rather than by the variant, to keep the counter.
        instantiateWasm(
          imports: WebAssembly.Imports,
          done: (instance: WebAssembly.Instance) => void,
        ) {
          const instance = new WebAssembly.Instance(wasmModule, imports);
          counter = instance.exports.naru_fuel as WebAssembly.Global;
          done(instance);
          return instance.exports;
        },
      } as never,
    }),
  );
  if (!(counter instanceof WebAssembly.Global))
    throw new Error("QuickJS was not built with a fuel meter (naru_fuel).");
  fuel.set(module, counter);
  return module;
}
