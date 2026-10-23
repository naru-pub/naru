"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loader, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { toast } from "sonner";
import { EDITABLE_FILE_EXTENSION_MAP } from "@/lib/const";
import { loadingFetch } from "@/lib/loading-bar";
import { extensionOf, isEditable, isWithin } from "./file-tree";

// The file manager's open files: its tabs, and for each text file a Monaco
// model the one editor switches between, so undo history, the cursor and
// scrolling survive switching tabs. A file is dirty while its model's
// version differs from the one last loaded or saved; undoing back to it
// makes it clean again. Saves send the ETag the file was loaded with, so one
// made over a newer version (from MCP, the apps, another tab) is refused.

type Model = editor.ITextModel;

interface Loaded {
  etag: string | null;
  savedVersion: number;
  // The stored file's text, for the diff view.
  savedText: string;
  listener: { dispose(): void };
}

export interface FileStatus {
  loading?: boolean;
  error?: string;
  savedAt?: number;
}

export type SaveResult = "saved" | "conflict" | "failed";

/** The editor's `path` for a file: a URI Monaco keys its model by. */
export const modelPath = (path: string) =>
  `file:///${path.split("/").map(encodeURIComponent).join("/")}`;

export const languageOf = (path: string) =>
  EDITABLE_FILE_EXTENSION_MAP[extensionOf(path)] ?? "plaintext";

async function fetchContent(path: string) {
  const response = await loadingFetch(
    `/api/files/content?path=${encodeURIComponent(path)}`,
  );
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "파일을 찾을 수 없습니다"
        : `파일을 불러올 수 없습니다: ${response.statusText}`,
    );
  }
  return {
    text: await response.text(),
    etag: response.headers.get("ETag"),
  };
}

function modelOf(monaco: Monaco | null, path: string): Model | null {
  return monaco
    ? monaco.editor.getModel(monaco.Uri.parse(modelPath(path)))
    : null;
}

export function useOpenFiles() {
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<Record<string, FileStatus>>({});
  const [monaco, setMonaco] = useState<Monaco | null>(null);
  const loaded = useRef(new Map<string, Loaded>());
  const pending = useRef(new Map<string, Promise<void>>());
  const monacoRef = useRef<Monaco | null>(null);

  const getModel = useCallback(
    (path: string) => modelOf(monacoRef.current, path),
    [],
  );

  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    let mounted = true;
    loader
      .init()
      .then((instance) => {
        monacoRef.current = instance;
        if (mounted) setMonaco(instance);
      })
      .catch(() => {});
    const models = loaded.current;
    return () => {
      mounted = false;
      // Models outlive the editor; leaving the file manager disposes ours.
      for (const [path, entry] of models) {
        entry.listener.dispose();
        modelOf(monacoRef.current, path)?.dispose();
      }
      models.clear();
    };
  }, []);

  const patchStatus = useCallback((path: string, patch: FileStatus | null) => {
    setStatus((previous) => {
      const next = { ...previous };
      if (patch) next[path] = { ...previous[path], ...patch };
      else delete next[path];
      return next;
    });
  }, []);

  const refreshDirty = useCallback(
    (path: string) => {
      const entry = loaded.current.get(path);
      const model = getModel(path);
      const isDirty =
        !!entry && !!model && model.getAlternativeVersionId() !== entry.savedVersion;
      setDirty((previous) => {
        if (previous.has(path) === isDirty) return previous;
        const next = new Set(previous);
        if (isDirty) next.add(path);
        else next.delete(path);
        return next;
      });
    },
    [getModel],
  );

  const adopt = useCallback(
    (
      path: string,
      text: string,
      etag: string | null,
      saved?: { version: number; text: string },
    ) => {
      const instance = monacoRef.current!;
      getModel(path)?.dispose();
      const model = instance.editor.createModel(
        text,
        languageOf(path),
        instance.Uri.parse(modelPath(path)),
      );
      loaded.current.set(path, {
        etag,
        savedVersion: saved?.version ?? model.getAlternativeVersionId(),
        savedText: saved?.text ?? text,
        listener: model.onDidChangeContent(() => refreshDirty(path)),
      });
      refreshDirty(path);
    },
    [getModel, refreshDirty],
  );

  const drop = useCallback(
    (path: string) => {
      loaded.current.get(path)?.listener.dispose();
      loaded.current.delete(path);
      getModel(path)?.dispose();
    },
    [getModel],
  );

  /** Fetches a text file into its model, once. */
  const load = useCallback(
    (path: string) => {
      if (!isEditable(path) || loaded.current.has(path)) return;
      if (pending.current.has(path)) return pending.current.get(path);
      const promise = (async () => {
        patchStatus(path, { loading: true, error: undefined });
        try {
          const [{ text, etag }] = await Promise.all([
            fetchContent(path),
            loader.init().then((instance) => {
              monacoRef.current = instance;
            }),
          ]);
          adopt(path, text, etag);
          patchStatus(path, { loading: false });
        } catch (error) {
          patchStatus(path, {
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "알 수 없는 오류가 발생했습니다",
          });
        } finally {
          pending.current.delete(path);
        }
      })();
      pending.current.set(path, promise);
      return promise;
    },
    [adopt, patchStatus],
  );

  const open = useCallback(
    (path: string) => {
      setTabs((previous) =>
        previous.includes(path) ? previous : [...previous, path],
      );
      setActive(path);
      load(path);
    },
    [load],
  );

  /** Shows tabs without loading them; each loads when it is activated. */
  const restore = useCallback((paths: string[], activePath: string | null) => {
    setTabs((previous) => [
      ...previous,
      ...paths.filter((path) => !previous.includes(path)),
    ]);
    if (activePath) setActive(activePath);
  }, []);

  useEffect(() => {
    if (active) load(active);
  }, [active, load]);

  const closeMany = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      for (const path of paths) {
        drop(path);
        patchStatus(path, null);
      }
      setDirty((previous) => {
        const next = new Set(previous);
        paths.forEach((path) => next.delete(path));
        return next;
      });
      const previous = tabsRef.current;
      const remaining = previous.filter((path) => !paths.includes(path));
      tabsRef.current = remaining;
      setTabs(remaining);
      setActive((current) => {
        if (!current || !paths.includes(current)) return current;
        // The tab beside the one closed, as editors do.
        const index = previous.indexOf(current);
        return (
          previous.slice(index + 1).find((path) => !paths.includes(path)) ??
          previous
            .slice(0, index)
            .reverse()
            .find((path) => !paths.includes(path)) ??
          null
        );
      });
    },
    [drop, patchStatus],
  );

  const close = useCallback((path: string) => closeMany([path]), [closeMany]);

  /** Closes the tabs of a deleted file or folder, discarding their edits. */
  const closeWithin = useCallback(
    (path: string) =>
      closeMany(tabsRef.current.filter((tab) => isWithin(tab, path))),
    [closeMany],
  );

  const save = useCallback(
    async (path: string, { force = false } = {}): Promise<SaveResult> => {
      const entry = loaded.current.get(path);
      const model = getModel(path);
      if (!entry || !model) return "failed";
      const contents = model.getValue();
      const version = model.getAlternativeVersionId();
      try {
        const response = await loadingFetch("/api/files/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: path,
            contents,
            ...(force || entry.etag === null ? {} : { etag: entry.etag }),
          }),
        });
        const result = await response.json();
        if (response.status === 409 && result.type === "CONFLICT") {
          return "conflict";
        }
        // A 503 with an ETag saved the file but not the follow-up work.
        if (result.success || result.etag) {
          entry.etag = result.etag ?? null;
          entry.savedVersion = version;
          entry.savedText = contents;
          refreshDirty(path);
          patchStatus(path, { savedAt: Date.now() });
          if (!result.success) toast.warning(result.message);
          return "saved";
        }
        toast.error(`저장 실패: ${result.message}`);
        return "failed";
      } catch {
        toast.error(`파일 저장에 실패했습니다: ${path}`);
        return "failed";
      }
    },
    [getModel, patchStatus, refreshDirty],
  );

  /** Replaces the model's text with the stored file's, as an undoable edit. */
  const reload = useCallback(
    async (path: string) => {
      const entry = loaded.current.get(path);
      const model = getModel(path);
      if (!entry || !model) return;
      try {
        const { text, etag } = await fetchContent(path);
        model.pushEditOperations(
          [],
          [{ range: model.getFullModelRange(), text }],
          () => null,
        );
        model.pushStackElement();
        entry.etag = etag;
        entry.savedVersion = model.getAlternativeVersionId();
        entry.savedText = text;
        refreshDirty(path);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "파일을 불러올 수 없습니다",
        );
      }
    },
    [getModel, refreshDirty],
  );

  /**
   * Follows a rename or move: the tabs under `from` take their new paths,
   * keeping unsaved edits. A model can't change its URI, so each is copied
   * to a new one, without its undo history.
   */
  const moved = useCallback(
    (from: string, to: string) => {
      const remap = (path: string) =>
        isWithin(path, from) ? to + path.slice(from.length) : path;
      const affected = [...loaded.current.keys()].filter((path) =>
        isWithin(path, from),
      );
      for (const path of affected) {
        const entry = loaded.current.get(path)!;
        const model = getModel(path);
        const next = remap(path);
        const wasDirty =
          !!model && model.getAlternativeVersionId() !== entry.savedVersion;
        const text = model?.getValue() ?? "";
        drop(path);
        if (model && isEditable(next)) {
          adopt(
            next,
            text,
            entry.etag,
            wasDirty ? { version: -1, text: entry.savedText } : undefined,
          );
          // A copy may not keep the ETag; take the new file's.
          fetchContent(next)
            .then(({ etag }) => {
              const current = loaded.current.get(next);
              if (current) current.etag = etag;
            })
            .catch(() => {});
        }
      }
      setTabs((previous) => [...new Set(previous.map(remap))]);
      setActive((current) => (current ? remap(current) : current));
      setDirty(
        (previous) =>
          new Set([...previous].map(remap).filter((path) => isEditable(path))),
      );
      setStatus((previous) =>
        Object.fromEntries(
          Object.entries(previous).map(([path, value]) => [remap(path), value]),
        ),
      );
    },
    [adopt, drop, getModel],
  );

  const isLoaded = useCallback((path: string) => loaded.current.has(path), []);
  const savedText = useCallback(
    (path: string) => loaded.current.get(path)?.savedText ?? "",
    [],
  );

  return {
    monaco,
    tabs,
    active,
    setActive,
    dirty,
    status,
    open,
    restore,
    close,
    closeMany,
    closeWithin,
    save,
    reload,
    moved,
    getModel,
    isLoaded,
    savedText,
  };
}
