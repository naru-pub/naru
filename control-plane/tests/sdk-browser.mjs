// The browser a test of the Data SDK runs it in (naru-data-sdk*.test.mjs).

// The SDK reads location, sessionStorage, localStorage and history as
// globals, the way a page does. Each test gets a fresh set, and every call
// fetch receives. `local` is the site's localStorage, which outlives a tab:
// pass the same Map to two runs to share it.
export async function browser(
  run,
  { href = "https://alice.naru.pub/admin.html", local = new Map() } = {},
) {
  const names = [
    "location",
    "sessionStorage",
    "localStorage",
    "history",
    "fetch",
  ];
  const saved = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  const storage = new Map();
  const calls = [];
  let respond = () => Response.json({});
  const location = {
    href,
    get origin() {
      return new URL(this.href).origin;
    },
    get pathname() {
      return new URL(this.href).pathname;
    },
    get hostname() {
      return new URL(this.href).hostname;
    },
    assign(url) {
      this.href = url;
    },
  };
  const values = {
    location,
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    localStorage: {
      getItem: (key) => local.get(key) ?? null,
      setItem: (key, value) => local.set(key, String(value)),
      removeItem: (key) => local.delete(key),
    },
    history: {
      state: null,
      replaceState: (_state, _title, url) => (location.href = url),
    },
    fetch: async (url, init = {}) => {
      const call = { url: new URL(url), method: "GET", ...init };
      calls.push(call);
      return respond(call);
    },
  };
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: values[name],
    });
  try {
    await run({
      calls,
      storage,
      local,
      location,
      respond: (handler) => (respond = handler),
    });
  } finally {
    names.forEach((name, index) =>
      saved[index]
        ? Object.defineProperty(globalThis, name, saved[index])
        : delete globalThis[name],
    );
  }
}
