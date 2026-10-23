"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

// State kept in localStorage, for the file manager's per-browser layout and
// editor preferences. Storage can be missing or refuse writes (private
// windows, blocked site data); values then live in memory for the page.

const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function readRaw(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function parse<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readStored<T>(key: string, fallback: T): T {
  return parse(readRaw(key), fallback);
}

export function writeStored(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try {
    window.localStorage.setItem(key, raw);
  } catch {
    // Nothing to do: the value stays in memory.
  }
  listeners.forEach((listener) => listener());
}

/**
 * useState kept under `key`. The server render, and the client's first,
 * use `fallback`, which should be a constant so the value keeps its identity.
 */
export function useStoredState<T>(key: string, fallback: T) {
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );
  const value = useMemo(() => parse(raw, fallback), [raw, fallback]);

  const set = useCallback(
    (next: T | ((previous: T) => T)) => {
      const resolved =
        typeof next === "function"
          ? (next as (previous: T) => T)(readStored(key, fallback))
          : next;
      writeStored(key, resolved);
    },
    [key, fallback],
  );

  return [value, set] as const;
}
