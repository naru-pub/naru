/**
 * Naru Data SDK 1.1.0: browser SDK for data owned by one Naru site, its
 * owner and its members. This release is still under active development.
 * @packageDocumentation
 */

/** A Naru operation that could not be completed. Check it with `instanceof`. */
export class NaruError extends Error {
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NaruError";
    this.code = code;
  }
}

// The server names the code. Only the codes this version knows are passed on,
// so a code added later reads as the nearest one this version has.
const CODES = new Set([
  "CONFLICT",
  "QUOTA_EXCEEDED",
  "AUTH_REQUIRED",
  "ACCESS_DENIED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "UNAVAILABLE",
]);
const errorCode = (status, code) => {
  if (CODES.has(code)) return code;
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "ACCESS_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UNAVAILABLE";
  return "INVALID_REQUEST";
};
const CONTROL_PLANE = "https://naru.pub";
// The data API, served from Seoul (sdk.naru.pub); sign-in stays on naru.pub.
const DATA_API = "https://sdk.naru.pub";
const SITE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
// Where requests go: the data API at sdk.naru.pub, sign-in at naru.pub. A
// page on alice.naru.pub belongs to the site alice, so only custom domains and
// local development say which site.
function target({ site } = {}) {
  site ||= /^([a-z0-9-]+)\.naru\.pub$/.exec(
    globalThis.location?.hostname ?? "",
  )?.[1];
  if (typeof site !== "string" || !SITE.test(site))
    throw new TypeError(
      "Pass { site: <Naru login name> } when the page is not on <site>.naru.pub.",
    );
  return {
    site,
    origin: CONTROL_PLANE,
    root: `${DATA_API}/api/data/v1/${site}`,
  };
}

// A document ID becomes a path segment. Checking it here keeps "..", which a
// URL would resolve away, from ever addressing something else.
function segment(value) {
  if (typeof value !== "string" || !ID.test(value))
    throw new TypeError(
      "Names and IDs are 1-64 ASCII letters, digits, underscores or hyphens.",
    );
  return value;
}

// Once this module writes a collection, its subsequent reads bypass caches.
// No cache lifetime is baked into deployed SDKs; the server may change it.
// A function call records the collections it changed, or "*" for any when its
// answer was lost.
const written = new Set();

// Accept only JSON values, without silently dropping or converting input.
function jsonValue(value, ancestors = new Set(), path = "data") {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value))
    throw new TypeError(
      `${path} must contain only JSON values (no cycles or non-finite numbers).`,
    );
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    throw new TypeError(
      `${path} must be a plain JSON object; convert dates to strings.`,
    );
  ancestors.add(value);
  const keys = Reflect.ownKeys(value).filter(
    (key) => !(array && key === "length"),
  );
  if (array && keys.length !== value.length)
    throw new TypeError(`${path} must be a dense JSON array.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      (array && !/^(0|[1-9][0-9]*)$/.test(key))
    )
      throw new TypeError(
        `${path} must contain only ordinary JSON properties.`,
      );
    jsonValue(descriptor.value, ancestors, `${path}.${key}`);
  }
  ancestors.delete(value);
}

// How long a request may go unanswered before it fails as UNAVAILABLE. Naru
// answers or refuses within about ten seconds, so a request still waiting
// after this is one that will not arrive: a page can say so instead of
// waiting on the browser's own limit, which can be minutes.
const REQUEST_TIMEOUT_MS = 15_000;

async function request(
  url,
  { method = "GET", body, token, signal, touches, renew },
) {
  const fresh =
    token ||
    method !== "GET" ||
    written.has("*") ||
    touches.some((path) => written.has(path));
  // An explicit transport flag makes cache bypass enforceable by the server.
  if (fresh && method === "GET") {
    const target = new URL(url);
    target.searchParams.set("fresh", "1");
    url = target.href;
  }
  // Serialization errors are input errors, never network failures.
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  let response;
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    response = await fetch(url, {
      method,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      credentials: "omit",
      redirect: "error",
      cache: fresh ? "no-store" : "default",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: encoded,
    });
  } catch (cause) {
    // The caller's own abort; a timeout (TimeoutError) is Naru's silence.
    if (cause?.name === "AbortError") throw cause;
    throw new NaruError(
      cause?.name === "TimeoutError"
        ? "Naru did not answer in time."
        : "Naru is unavailable.",
      "UNAVAILABLE",
      cause,
    );
  } finally {
    // Also when the response was lost: the write may still have landed.
    if (method !== "GET") for (const path of touches) written.add(path);
  }
  // A token's lifetime is an idle window the server pushes forward as the
  // token is used, and this is the expiry it now has. It arrives as a duration
  // so this browser's clock, however wrong, only measures it.
  const renewed = response.headers.get("Naru-Owner-Expires-In");
  if (renew && renewed !== null && Number.isFinite(Number(renewed)))
    renew(Date.now() + Number(renewed) * 1000);
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new NaruError(
      typeof result?.error?.message === "string"
        ? result.error.message
        : `Database request failed (HTTP ${response.status}).`,
      errorCode(response.status, result?.error?.code),
    );
    // What a site function passed to ctx.fail, for the page to branch on.
    if (result?.error?.details !== undefined)
      Object.defineProperty(error, "details", {
        value: result.error.details,
        enumerable: true,
      });
    throw error;
  }
  // A proxy or challenge page can answer 200 with HTML. Handing that back as
  // an empty result would make a missing document look like a present one.
  if (result === null || typeof result !== "object")
    throw new NaruError(
      `The data API did not answer with JSON (HTTP ${response.status}).`,
      "UNAVAILABLE",
    );
  return result;
}

function query({ filter, where, sort, size, after, includeTotal } = {}) {
  const parameters = new URLSearchParams();
  if (filter && Object.keys(filter).length)
    parameters.set("filter", JSON.stringify(filter));
  if (where !== undefined) parameters.set("where", JSON.stringify(where));
  if (sort) parameters.set("sort", JSON.stringify(sort));
  if (size !== undefined) parameters.set("size", String(size));
  if (after) parameters.set("after", after);
  if (includeTotal) parameters.set("includeTotal", "1");
  const text = String(parameters);
  return text ? `?${text}` : "";
}

// Shared by single writes and batches, so both refuse the same mistakes here.
// A delete conditional on absence could only ever do nothing.
function checkCondition(value, { deleting = false } = {}) {
  if (value === undefined) return value;
  if (!value || typeof value !== "object")
    throw new TypeError("condition must contain revision or absent.");
  if (Object.keys(value).length !== 1)
    throw new TypeError("condition must contain only revision or absent.");
  if (Object.hasOwn(value, "revision")) {
    const { revision } = value;
    if (typeof revision !== "string" || !revision)
      throw new TypeError("condition.revision must be returned by Naru.");
    return value;
  }
  if (value.absent === true && !deleting) return value;
  throw new TypeError(
    deleting
      ? "A delete can only be conditional on a revision."
      : "condition must contain revision or absent.",
  );
}

function condition(value, options) {
  checkCondition(value, options);
  if (value === undefined) return "";
  const { revision } = value;
  return revision
    ? `?ifRevision=${encodeURIComponent(revision)}`
    : "?ifAbsent=1";
}

function documents(root, name, send) {
  const path = `${root}/${segment(name)}`;
  const touches = [path];
  const list = (options = {}) =>
    send(`${path}${query(options)}`, { signal: options.signal, touches });
  return Object.freeze({
    async get(id, { signal } = {}) {
      const result = await send(`${path}/${segment(id)}`, { signal, touches });
      return result.document;
    },
    async getMany(ids, { signal } = {}) {
      if (!Array.isArray(ids) || ids.length > 100)
        throw new TypeError("getMany needs at most 100 IDs.");
      for (const id of ids) segment(id);
      const result = await send(
        `${path}?ids=${encodeURIComponent(JSON.stringify(ids))}`,
        { signal, touches },
      );
      return result.documents;
    },
    list,
    // A total rides along with a one-document page; the list request is all
    // the server needs to support.
    async count({ filter, where, signal } = {}) {
      return (
        await list({ filter, where, size: 1, includeTotal: true, signal })
      ).totalCount;
    },
    // Each page as it arrives, following nextCursor. Like the pages it walks,
    // this is not a snapshot: writes in between can shift later pages.
    async *pages(options = {}) {
      let after = options.after;
      do {
        const page = await list({ ...options, after });
        yield page;
        after = page.nextCursor;
      } while (after);
    },
    add(data, { secret, signal } = {}) {
      jsonValue(data);
      return send(path, {
        method: "POST",
        body: { data, ...secretOf(secret) },
        signal,
        touches,
      });
    },
    set(id, data, { signal, secret, condition: expected } = {}) {
      jsonValue(data);
      return send(`${path}/${segment(id)}${condition(expected)}`, {
        method: "PUT",
        body: { data, ...secretOf(secret) },
        signal,
        touches,
      });
    },
    async delete(id, { signal, secret, condition: expected } = {}) {
      await send(
        `${path}/${segment(id)}${condition(expected, { deleting: true })}`,
        {
          method: "DELETE",
          ...(secret === undefined ? {} : { body: secretOf(secret) }),
          signal,
          touches,
        },
      );
    },
  });
}

/** A write secret as the request body carries it; checked before sending. */
function secretOf(secret) {
  if (secret === undefined) return {};
  if (typeof secret !== "string" || !secret || secret.length > 256)
    throw new TypeError("A secret is 1-256 characters.");
  return { secret };
}

/** A collection of the site this page belongs to. Nothing is requested yet. */
function publicDocuments(root, name) {
  const collection = documents(root, name, request);
  return Object.freeze({
    get: collection.get,
    getMany: collection.getMany,
    list: collection.list,
    count: collection.count,
    pages: collection.pages,
    add: collection.add,
    set: collection.set,
    delete: collection.delete,
  });
}

// Photos straight off a phone are several megabytes and thousands of pixels
// for an image a page shows at a fraction of that. Uploads go straight to
// object storage, so the browser is the only place to shrink them: before the
// upload is authorized, so quota counts what is stored, and by re-encoding,
// which drops EXIF so a photo's location never reaches the public URL.
const MAX_EDGE = 2048;
// Naru never stores HEIC, so a photo in it is converted or refused here. The
// other types Naru stores are the server's to say, and may grow.
const HEIC = /^image\/hei[cf]$/;
const HEIC_NAME = /\.hei[cf]$/i;
const SMALL_BYTES = 512 * 1024;
async function shrink(file) {
  const heic = HEIC.test(file.type);
  if (
    !(heic || /^image\/(jpeg|png|webp)$/.test(file.type)) ||
    typeof createImageBitmap !== "function"
  )
    return file;
  let bitmap;
  try {
    // Canvas discards EXIF, so orientation is baked into the pixels here.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && !heic && file.size <= SMALL_BYTES) return file;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    for (const type of ["image/webp", "image/jpeg"]) {
      const canvas =
        typeof OffscreenCanvas === "function"
          ? new OffscreenCanvas(width, height)
          : Object.assign(document.createElement("canvas"), { width, height });
      // Spelled out: which overload a union of canvases resolves to depends on
      // what else a program compiles, and the application's does differ.
      const context = canvas.getContext("2d");
      if (!context) return file;
      // JPEG has no transparency; paint white rather than let it go black.
      if (type === "image/jpeg") {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await ("convertToBlob" in canvas
        ? canvas.convertToBlob({ type, quality: 0.82 })
        : new Promise((resolve) => canvas.toBlob(resolve, type, 0.82)));
      // A browser that cannot encode a type quietly returns PNG instead.
      if (blob?.type !== type) continue;
      // HEIC is not accepted as is, so its conversion is kept even if larger.
      if (!heic && blob.size >= file.size) return file;
      const base = (file.name || "upload").replace(/\.[^.]*$/, "");
      return new File([blob], `${base}.${type.slice(6)}`, { type });
    }
    return file;
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}

// The bytes go from the browser straight to object storage on a signed URL.
// fetch reports nothing of a body it sends, and streaming one to count it
// would drop the Content-Length a signed PUT needs, so a caller who asked for
// progress gets the same PUT through XMLHttpRequest. It answers like fetch:
// { ok, status }, a TypeError for a network failure, and the signal's reason
// for an abort.
function put(url, headers, file, signal, uploading) {
  if (!uploading)
    return fetch(url, {
      method: "PUT",
      headers,
      body: file,
      signal,
      credentials: "omit",
      redirect: "error",
    });
  return new Promise((resolve, reject) => {
    const aborted = () =>
      signal?.reason ??
      new DOMException("The upload was aborted.", "AbortError");
    if (signal?.aborted) return reject(aborted());
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const settle = (finish) => {
      signal?.removeEventListener("abort", abort);
      finish();
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.open("PUT", url);
    for (const [name, value] of Object.entries(headers))
      request.setRequestHeader(name, value);
    request.upload.onprogress = (event) =>
      uploading(Math.min(event.loaded, file.size));
    // XMLHttpRequest follows redirects it cannot be told to refuse. Storage
    // never redirects a signed upload, so one that moved is not trusted.
    request.onload = () =>
      settle(() =>
        resolve({
          ok:
            request.status >= 200 &&
            request.status < 300 &&
            request.responseURL === new URL(url).href,
          status: request.status,
        }),
      );
    request.onerror = request.ontimeout = () =>
      settle(() => reject(new TypeError("The upload connection failed.")));
    request.onabort = () => settle(() => reject(aborted()));
    request.send(file);
    // After send: an abort from this first report must reach a sent request,
    // which fires abort, rather than an unsent one, which would not.
    uploading(0);
  });
}

// Uploading, as an owner or a member: the same requests, with the token the
// handle sends them with.
function media(root, send) {
  return Object.freeze({
    async delete(id, { signal, uploadedBy } = {}) {
      if (signal?.aborted)
        throw (
          signal.reason ??
          new DOMException("The deletion was aborted.", "AbortError")
        );
      if (
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      )
        throw new TypeError("media.delete() needs an uploaded file ID.");
      const guard =
        uploadedBy === undefined
          ? ""
          : `?uploadedBy=${uploadedBy === null ? "owner" : segment(uploadedBy)}`;
      await send(`${root}/_files/${id}${guard}`, {
        method: "DELETE",
        signal,
        touches: [],
      });
    },
    async upload(source, { signal, managed, onProgress } = {}) {
      if (onProgress !== undefined && typeof onProgress !== "function")
        throw new TypeError("onProgress must be a function.");
      if (managed !== undefined && typeof managed !== "boolean")
        throw new TypeError("managed must be a boolean.");
      // A caller's mistake in its progress handler is reported, never
      // allowed to fail an upload partway through.
      const report = (progress) => {
        try {
          onProgress?.(progress);
        } catch (error) {
          if (typeof reportError === "function") reportError(error);
          else
            setTimeout(() => {
              throw error;
            });
        }
      };
      report({ phase: "preparing" });
      // Some browsers leave an iPhone photo's type empty.
      const file = await shrink(
        !source.type && HEIC_NAME.test(source.name ?? "")
          ? new File([source], source.name, { type: "image/heic" })
          : source,
      );
      if (HEIC.test(file.type))
        throw new TypeError(
          "This browser cannot convert HEIC photos. Upload from Safari, or convert the photo to JPEG first.",
        );
      const authorization = await send(`${root}/_files`, {
        method: "POST",
        body: {
          name: file.name || "upload",
          contentType: file.type,
          size: file.size,
          ...(managed ? { managed: true } : {}),
        },
        signal,
        touches: [],
      });
      let upload;
      try {
        upload = await put(
          authorization.uploadUrl,
          authorization.headers,
          file,
          signal,
          onProgress &&
            ((loaded) =>
              report({ phase: "uploading", loaded, total: file.size })),
        );
      } catch (cause) {
        if (cause?.name === "AbortError") throw cause;
        throw new NaruError("File upload failed.", "UNAVAILABLE", cause);
      }
      // An upload that never finishes is removed by the server within an
      // hour. Storage refusing the bytes (an expired authorization, say) is
      // fixed by uploading again, which authorizes afresh.
      if (!upload.ok)
        throw new NaruError(
          `File upload failed (HTTP ${upload.status}).`,
          "UNAVAILABLE",
        );
      report({ phase: "finishing" });
      const finished = await send(
        `${root}/_files/${segment(authorization.id)}`,
        { method: "PUT", body: {}, signal, touches: [] },
      );
      // What was stored, which shrinking may have renamed and re-encoded.
      const { url, name, contentType, size } = finished.file;
      return { id: authorization.id, url, name, contentType, size };
    },
  });
}

const ownerPlace = ({ origin, site }) => ({
  store: () => sessionStorage,
  key: `naru:owner:${origin}:${site}:${location.origin}${location.pathname}`,
});
const memberPlace = ({ origin, site }) => ({
  store: () => localStorage,
  key: `naru:member:${origin}:${site}`,
});

function saved({ store, key }) {
  try {
    return JSON.parse(store().getItem(key) ?? "null");
  } catch {
    return null; /* unreadable or blocked, so no session */
  }
}

// An older client must not erase or outlive a newer sign-in made in the same
// place, so both of these only touch a stored session that is still this one.
function forget(place, token) {
  try {
    if (saved(place)?.accessToken === token)
      place.store().removeItem(place.key);
  } catch {
    /* storage blocked: nothing was kept */
  }
}

function remember(place, token, expiresAt) {
  const session = saved(place);
  try {
    if (session?.accessToken === token)
      place
        .store()
        .setItem(place.key, JSON.stringify({ ...session, expiresAt }));
  } catch {
    /* storage blocked: the handle still holds it */
  }
}

// What an owner's and a member's handle share: a token the server renews as
// it is used, so a tab left open while it is used is not signed out midway,
// and which the handle refuses to send once signed out or expired.
function credential(place, token, expiresAt) {
  const renew = (at) => {
    if (!(at > expiresAt)) return;
    expiresAt = at;
    remember(place, token, at);
  };
  let signedOut = false;
  const send = async (url, init) => {
    if (signedOut || Date.now() >= expiresAt) {
      forget(place, token);
      throw new NaruError("Sign in again.", "AUTH_REQUIRED");
    }
    try {
      return await request(url, { ...init, token, renew });
    } catch (error) {
      if (error.code === "AUTH_REQUIRED") forget(place, token);
      throw error;
    }
  };
  /** Forgets the session here first, then asks Naru to revoke it. */
  const signOut = async (revoke) => {
    signedOut = true;
    forget(place, token);
    await request(revoke, { method: "POST", token, touches: [] });
  };
  return { send, signOut };
}

// A mistake in an application's callback is reported, never allowed to break
// the SDK work that called it.
function guarded(fn, ...args) {
  try {
    fn?.(...args);
  } catch (error) {
    if (typeof reportError === "function") reportError(error);
    else
      setTimeout(() => {
        throw error;
      });
  }
}

// A live connection to the site's object, through the edge. It reconnects
// with growing pauses while the network or the site is away, and stops for
// good when closed, or when the server ends the member's access (4003). A
// member's connection opens with a fresh ticket each time (`ticket`).
function live(root, options, ticket) {
  if (!options || typeof options.onMessage !== "function")
    throw new TypeError("live() needs an onMessage function.");
  const topics = [...(options.topics ?? [])];
  if (topics.length > 8) throw new TypeError("Listen to at most 8 topics.");
  topics.forEach(segment);
  let socket;
  let closed = false;
  let attempt = 0;
  let timer;
  let keepalive;
  const status = (value) => guarded(options.onStatus, value);
  const stop = () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(keepalive);
    status("closed");
  };
  const retry = () => {
    if (closed) return;
    status("reconnecting");
    const pause = Math.min(30_000, 1000 * 2 ** attempt++);
    timer = setTimeout(open, pause / 2 + (Math.random() * pause) / 2);
  };
  async function open() {
    if (closed) return;
    const url = new URL(`${root}/_live`);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    if (topics.length) url.searchParams.set("topics", topics.join(","));
    if (ticket)
      try {
        url.searchParams.set("ticket", await ticket());
      } catch (error) {
        const code = error.code;
        if (code === "AUTH_REQUIRED" || code === "ACCESS_DENIED") stop();
        else retry();
        return;
      }
    if (closed) return;
    const current = new WebSocket(url);
    socket = current;
    current.onopen = () => {
      attempt = 0;
      status("open");
      // Answered by the server without waking the site's object.
      keepalive = setInterval(() => current.send("ping"), 50_000);
    };
    current.onmessage = (event) => {
      if (event.data === "pong") return;
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      guarded(options.onMessage, message);
    };
    current.onclose = (event) => {
      clearInterval(keepalive);
      if (socket === current) socket = undefined;
      if (closed) return;
      if (event.code === 4003) stop();
      else retry();
    };
  }
  status("connecting");
  void open();
  return Object.freeze({
    close() {
      if (closed) return;
      stop();
      socket?.close(1000);
    },
  });
}

// Calling a site function, as a member or the owner: the same request with the
// handle's token. The server says which collections the call changed, so only
// their later reads skip caches; a call whose answer was lost may have changed
// any of them.
function functions(root, send) {
  return async function call(name, args = null, { signal } = {}) {
    const parts = typeof name === "string" ? name.split(":") : [];
    if (parts.length !== 2)
      throw new TypeError('call() names "<module/path>:<function>".');
    parts[0].split("/").forEach(segment);
    segment(parts[1]);
    jsonValue(args, undefined, "args");
    let answer;
    try {
      answer = await send(`${root}/_call/${parts[0]}:${parts[1]}`, {
        method: "POST",
        body: { args },
        signal,
        touches: [],
      });
    } catch (error) {
      if (!(error instanceof NaruError) || error.code === "UNAVAILABLE")
        written.add("*");
      throw error;
    }
    for (const collection of answer.written ?? ["*"])
      written.add(collection === "*" ? "*" : `${root}/${collection}`);
    return answer.result;
  };
}

function admin(context, token, expiresAt) {
  const { origin, root } = context;
  const { send, signOut } = credential(ownerPlace(context), token, expiresAt);
  return Object.freeze({
    collection: (name) => documents(root, name, send),
    async batch(writes, { signal } = {}) {
      const operations = writes.map(({ collection, set, delete: remove }) => {
        const write = set ?? remove;
        if (!write || Boolean(set) === Boolean(remove))
          throw new TypeError("Each batch write must set or delete.");
        if (set) jsonValue(set.data);
        segment(collection);
        segment(write.id);
        checkCondition(write.condition, { deleting: !set });
        return {
          type: set ? "set" : "delete",
          collection,
          id: write.id,
          ...(set ? { data: set.data } : {}),
          ...(write.condition ? { condition: write.condition } : {}),
        };
      });
      const touches = [
        ...new Set(operations.map((item) => `${root}/${item.collection}`)),
      ];
      const { results } = await send(`${root}/_batch`, {
        method: "POST",
        body: { operations },
        signal,
        touches,
      });
      // In the order written: what each set stored, and null for a delete.
      return results.map((result) =>
        result
          ? {
              id: result.id,
              revision: result.revision,
              createdAt: result.createdAt,
              updatedAt: result.updatedAt,
            }
          : null,
      );
    },
    call: functions(root, send),
    media: media(root, send),
    signOut: () => signOut(`${origin}/api/data-auth/v1/revoke`),
  });
}

function member(context, token, expiresAt, id) {
  const { origin, root } = context;
  const { send, signOut } = credential(memberPlace(context), token, expiresAt);
  return Object.freeze({
    id,
    membership: ({ signal } = {}) =>
      send(`${origin}/api/membership/v1/${context.site}`, {
        method: "GET",
        signal,
        touches: [],
      }),
    collection: (name) => documents(root, name, send),
    call: functions(root, send),
    live: (options) =>
      live(root, options, async () => {
        const { ticket } = await send(`${root}/_live`, {
          method: "POST",
          body: {},
          touches: [],
        });
        return ticket;
      }),
    media: media(root, send),
    signOut: () => signOut(`${origin}/api/data-auth/v1/member-revoke`),
  });
}

const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
// The page this tab is at. Naru sends the sign-in back to it, so the session
// below is found where it was left; the rest of the address is restored then.
const callback = () => location.origin + location.pathname;

/**
 * Leaves for Naru's approval page at `path` with `query`, keeping what it
 * takes to finish when Naru sends the tab back.
 */
async function leave(context, place, path, query) {
  const verifier = random();
  const state = random();
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  // The PKCE transaction has to survive the round trip through Naru.
  sessionStorage.setItem(
    `${place.key}:pending`,
    JSON.stringify({
      verifier,
      state,
      startedAt: Date.now(),
      address: location.href,
    }),
  );
  const approval = new URL(path, context.origin);
  approval.search = String(
    new URLSearchParams({
      site: context.site,
      redirectUri: callback(),
      challenge,
      state,
      ...query,
    }),
  );
  location.assign(approval.href);
}

/**
 * Leaves for Naru, where the owner approves access to `collections`, and comes
 * back to this page. Register this page's URL as an administrator callback in
 * the control panel first; Naru says so on its own page if it is not.
 */
async function signIn(context, collections, mediaDelete = false, settings) {
  if (typeof mediaDelete !== "boolean")
    throw new TypeError("mediaDelete must be a boolean.");
  // Checked here so a bad name fails on this page, not on Naru's consent page.
  collections.forEach(segment);
  if (settings !== undefined) {
    if (!settings || typeof settings !== "object")
      throw new TypeError("settings must map collection names to settings.");
    for (const [name, value] of Object.entries(settings)) {
      if (!collections.includes(name))
        throw new TypeError(`settings names ${name}, which is not requested.`);
      if (!value || typeof value !== "object")
        throw new TypeError(`Invalid settings for ${name}.`);
    }
  }
  await leave(context, ownerPlace(context), "/database/authorize", {
    collections: collections.join(","),
    ...(settings && Object.keys(settings).length
      ? { settings: JSON.stringify(settings) }
      : {}),
    ...(mediaDelete ? { mediaDelete: "1" } : {}),
  });
}

/**
 * The token Naru's redirect back to this page carries, or null when this is
 * not that redirect: then the page's own `?code=`, `?error=` and `?state=`
 * are left alone. Only the sign-in this tab started in `place`, with the same
 * state, is finished, so an owner's and a member's sign-in never take each
 * other's code.
 */
async function returned(context, place, exchange) {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const denied = url.searchParams.get("error");
  const state = url.searchParams.get("state");
  let pending = null;
  try {
    pending = JSON.parse(
      sessionStorage.getItem(`${place.key}:pending`) ?? "null",
    );
  } catch {
    /* unreadable, so no sign-in to finish */
  }
  if (!pending || pending.state !== state || (code === null && denied === null))
    return null;
  for (const name of ["code", "state", "error"]) url.searchParams.delete(name);
  // Back to the address the sign-in left from, when that is this page.
  const left = pending.address ? new URL(pending.address) : null;
  history.replaceState(
    history.state,
    "",
    left && left.origin + left.pathname === url.origin + url.pathname
      ? left.href
      : url.href,
  );
  sessionStorage.removeItem(`${place.key}:pending`);
  if (!(Date.now() - pending.startedAt < 10 * 60 * 1000))
    throw new NaruError("Sign-in expired.", "AUTH_REQUIRED");
  if (denied !== null)
    throw new NaruError("Sign-in was denied.", "ACCESS_DENIED");
  const startedAt = Date.now();
  const token = await request(`${context.origin}${exchange}`, {
    method: "POST",
    body: { code, verifier: pending.verifier, redirectUri: callback() },
    touches: [],
  });
  // The lifetime is measured on this browser's clock from before the request,
  // so a clock set wrong can neither end the session early nor extend it.
  return {
    ...token,
    expiresAt: Number.isFinite(token.expiresIn)
      ? startedAt + token.expiresIn * 1000
      : token.expiresAt,
  };
}

/**
 * The signed-in admin client for this page, or null. Finishes a sign-in when
 * Naru has just redirected back, and otherwise restores this tab's session.
 * Call it before rendering: it removes the one-time code from the address bar.
 *
 * A sign-in that came back without completing (denied, stale, or a failed
 * exchange) is an ordinary signed-out visit, never a page failure. The owner
 * who denied it knows; anything else is fixed by signing in again.
 */
async function adminSession(context) {
  const place = ownerPlace(context);
  try {
    const token = await returned(context, place, "/api/data-auth/v1/token");
    if (token) {
      place.store().setItem(
        place.key,
        JSON.stringify({
          accessToken: token.accessToken,
          expiresAt: token.expiresAt,
        }),
      );
      return admin(context, token.accessToken, token.expiresAt);
    }
  } catch (error) {
    if (error instanceof NaruError) return null;
    throw error;
  }
  const session = saved(place);
  if (session && session.expiresAt > Date.now())
    return admin(context, session.accessToken, session.expiresAt);
  place.store().removeItem(place.key);
  return null;
}

/**
 * The member signed in to this site, or null, like `adminSession`: from
 * Naru's redirect back, or from the site's storage.
 */
async function memberSession(context) {
  const place = memberPlace(context);
  try {
    const token = await returned(
      context,
      place,
      "/api/data-auth/v1/member-token",
    );
    if (token) {
      const id = token.memberId;
      try {
        place.store().setItem(
          place.key,
          JSON.stringify({
            accessToken: token.accessToken,
            expiresAt: token.expiresAt,
            memberId: id,
          }),
        );
      } catch {
        /* storage blocked: signed in on this page only */
      }
      return member(context, token.accessToken, token.expiresAt, id);
    }
  } catch (error) {
    if (error instanceof NaruError) return null;
    throw error;
  }
  const session = saved(place);
  if (session?.memberId && session.expiresAt > Date.now())
    return member(
      context,
      session.accessToken,
      session.expiresAt,
      session.memberId,
    );
  try {
    place.store().removeItem(place.key);
  } catch {
    /* storage blocked: nothing was kept */
  }
  return null;
}

/** Creates a client bound to one site. */
export function createNaru(options) {
  const context = target(options);
  return Object.freeze({
    collection: (name) => publicDocuments(context.root, name),
    live: (options) => live(context.root, options),
    call: functions(context.root, request),
    auth: Object.freeze({
      session: () => adminSession(context),
      signIn: ({ collections, settings, mediaDelete }) =>
        signIn(context, collections, mediaDelete, settings),
    }),
    members: Object.freeze({
      session: () => memberSession(context),
      signIn: () =>
        leave(context, memberPlace(context), "/members/sign-in", {}),
    }),
  });
}
