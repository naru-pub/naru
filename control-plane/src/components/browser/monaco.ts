"use client";

import { loader, type Monaco } from "@monaco-editor/react";

// Monaco from naru.pub itself (scripts/copy-monaco.mjs), not the loader's
// default CDN, which failed to load it or its workers for some visitors.
const VS = "/monaco-editor/vs";
loader.config({ paths: { vs: VS } });

// A script that fails to load, on a flaky mobile connection say, is tried
// again this many times before the editor gives up.
const ATTEMPTS = 3;

type AmdRequire = {
  (
    modules: string[],
    onLoad: (loaded: { m?: Monaco } & Monaco) => void,
    onError: (error: unknown) => void,
  ): void;
  config(config: object): void;
  reset(): void;
};

let loading: Promise<Monaco> | null = null;

/**
 * Loads Monaco once for the page and gives it to @monaco-editor/react, whose
 * editors then use it instead of loading their own. Its loader keeps a failed
 * load's rejection for the page's lifetime, leaving every later editor dead
 * until a reload, and leaks it as an unhandled rejection from each call. A
 * failed load here is forgotten, so opening a file again tries again.
 */
export function loadMonaco(): Promise<Monaco> {
  if (!loading) {
    loading = load().then((monaco) => {
      loader.config({ monaco });
      return monaco;
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

async function load(): Promise<Monaco> {
  for (let attempt = 1; ; attempt++) {
    try {
      const amd = await loaderScript();
      // The loader remembers a module that failed and never fetches it
      // again, so a retry starts a fresh one. Not as the failure is reported:
      // the failed attempt's other scripts are still arriving then, and would
      // define their modules in the fresh loader before it is configured.
      if (attempt > 1) amd.reset();
      return await requireEditor(amd);
    } catch (error) {
      if (attempt === ATTEMPTS) {
        throw new Error(
          "편집기를 불러오지 못했습니다. 네트워크 연결을 확인하고 파일을 다시 열어주세요.",
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

function loaderScript(): Promise<AmdRequire> {
  const existing = (window as unknown as { require?: AmdRequire }).require;
  if (typeof existing?.reset === "function") return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${VS}/loader.js`;
    script.onload = () =>
      resolve((window as unknown as { require: AmdRequire }).require);
    script.onerror = () => {
      script.remove();
      reject(new Error(`${script.src} failed to load`));
    };
    document.body.appendChild(script);
  });
}

function requireEditor(amd: AmdRequire): Promise<Monaco> {
  return new Promise((resolve, reject) => {
    amd.config({ paths: { vs: VS } });
    amd(
      ["vs/editor/editor.main"],
      // 0.53 and later export the API as `m`.
      (loaded) => resolve(loaded.m ?? loaded),
      reject,
    );
  });
}
