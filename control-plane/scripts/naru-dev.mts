// A local Naru for one site:
//   pnpm naru-dev <site folder> [--site name] [--port 4000] [--state dir]
//
// Runs the real edge Worker (`wrangler dev`, workerd with SQLite-backed
// Durable Objects), so documents, collection rules, site functions, live
// connections and limits behave as on Naru. This process stands in for the
// control plane around it: it serves the site's files and the SDK (pointed at
// itself), signs owners and members in on one click, answers the requests
// that carry a sign-in, keeps uploads in a folder, and republishes `_naru/`
// whenever a file there changes. Data persists in <site folder>/.naru-dev/.
//
// Not emulated: payments, quotas of the control plane (media size), custom
// domains, and anything of naru.pub beyond the site's own API. Install
// ../edge first (pnpm install there).
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import {
  parseFilterQuery,
  parseWhereQuery,
} from "../src/lib/site-data/filters";
import { signLiveTicket } from "../src/lib/site-data/live-ticket";
import { publicResult, websiteCondition } from "../src/lib/site-data/protocol";
import { DataError, functionReference } from "../src/lib/site-data/validation";

const args = process.argv.slice(2);
const option = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args.splice(index, 2)[1] : undefined;
};
const port = Number(option("--port") ?? 4000);
const siteOption = option("--site");
const stateOption = option("--state");
const folder = resolve(args[0] ?? ".");
const site = siteOption ?? "localsite";
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(site)) {
  console.error(
    "--site takes a Naru login name: lowercase letters, digits, hyphens.",
  );
  process.exit(2);
}
const origin = `http://localhost:${port}`;
const OWNER = "1";
// --state keeps a test's data apart from the site's own .naru-dev/.
const state = stateOption ? resolve(stateOption) : join(folder, ".naru-dev");
const mediaDir = join(state, "media", OWNER);
const root = resolve(import.meta.dirname, "..");
const edge = resolve(root, "../edge");

/* ------------------------------------------------------- edge Worker --- */

const secret = randomBytes(24).toString("base64url");
const workerPort = port + 1;
if (!existsSync(join(edge, "node_modules/.bin/wrangler"))) {
  console.error("Run pnpm install in edge/ first.");
  process.exit(1);
}
await mkdir(mediaDir, { recursive: true });
const worker = spawn(
  join(edge, "node_modules/.bin/wrangler"),
  [
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(workerPort),
    "--inspector-port",
    String(port + 2),
    "--persist-to",
    join(state, "worker"),
    "--var",
    `EDGE_WORKER_SECRET:${secret}`,
    "--var",
    `PASSTHROUGH_ORIGIN:${origin}`,
    "--var",
    "TEST_OPERATIONS:1",
    // Every browser and tab on this machine is one address here, which the
    // per-address read limit would otherwise count as one heavy reader.
    "--var",
    "SITE_READS_PER_MINUTE:100000",
    // Here the local Worker is every site's database, whatever production's
    // config says has moved to the mini.
    "--var",
    "MOVED_SITES:",
    "--log-level",
    "warn",
  ],
  { cwd: edge, stdio: ["ignore", "inherit", "inherit"] },
);
const stop = () => {
  worker.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const workerUrl = `http://127.0.0.1:${workerPort}`;
for (let tries = 0; ; tries++) {
  try {
    await fetch(workerUrl);
    break;
  } catch {
    if (tries > 300) throw new Error("The edge Worker did not start.");
    await new Promise((done) => setTimeout(done, 200));
  }
}

/** One operation on the site's object, as the control plane calls it. */
async function object<T>(operation: string, input: unknown): Promise<T> {
  const response = await fetch(`${workerUrl}/v1/sites/${site}/${operation}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const answer = (await response.json()) as {
    value?: T;
    error?: {
      status: number;
      message: string;
      code?: string;
      details?: unknown;
      site?: boolean;
    };
  };
  if (answer.error)
    throw new DataError(
      answer.error.status,
      answer.error.message,
      answer.error.code as never,
      answer.error.details,
      answer.error.site,
    );
  return answer.value as T;
}

// Paid for ten years, as far as the object knows, so it answers visitors.
await object("configure", {
  ownerId: OWNER,
  entitledUntil: null,
  confirmedUntil: Date.now() + 10 * 365 * 86400 * 1000,
  monthlyRequests: null,
});

/* ----------------------------------------------- _naru/ publication --- */

const FOLDERS = ["functions", "modules", "rules"] as const;
async function files(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (/\.m?js$/.test(entry.name)) found.push(path);
  }
  return found;
}
/** Publishes one `_naru/<folder>/<path>.js`, or removes it when gone. */
async function publish(path: string, publishing = true) {
  const inside = relative(join(folder, "_naru"), path).split(sep);
  const kind = inside[0] as (typeof FOLDERS)[number];
  if (!FOLDERS.includes(kind) || !/\.m?js$/.test(path)) return;
  const file = inside
    .slice(1)
    .join("/")
    .replace(/\.m?js$/, "");
  const source = existsSync(path) ? await readFile(path, "utf8") : null;
  try {
    await object("putFunctions", {
      site,
      folder: kind,
      file,
      source,
      publish: publishing,
    });
    if (publishing) console.log(`published _naru/ (${kind}/${file} changed)`);
  } catch (error) {
    console.error(`_naru/${kind}/${file}: ${(error as Error).message}`);
  }
}
// Every file first, then one publication: modules import each other.
const everything = (
  await Promise.all(FOLDERS.map((kind) => files(join(folder, "_naru", kind))))
).flat();
for (const [index, path] of everything.entries())
  await publish(path, index === everything.length - 1);

/**
 * `_naru/collections.json`, the collections the site declares, installed as
 * Naru installs it when the file arrives (lib/site-data/declared-collections.ts):
 * here every declared setting is applied at once, changes to existing
 * collections included, since the one running naru-dev is the owner.
 */
async function installDeclaration() {
  const path = join(folder, "_naru", "collections.json");
  if (!existsSync(path)) return;
  try {
    const declared = JSON.parse(await readFile(path, "utf8")).collections as
      | Record<
          string,
          {
            read: string;
            write: string;
            rules?: string | null;
            unique?: string[];
            indexes?: string[];
          }
        >
      | undefined;
    if (!declared || typeof declared !== "object")
      throw new Error('it needs a "collections" object');
    const names = Object.keys(declared);
    for (const name of names)
      if (!declared[name]?.read || !declared[name]?.write)
        throw new Error(`"${name}" needs both "read" and "write"`);
    const existing = await object<
      {
        name: string;
        read_access: string;
        write_access: string;
        rules?: string;
        unique?: string[];
        indexes?: string[];
      }[]
    >("collections", { names });
    const wanted = names.map((name) => ({
      name,
      read_access: declared[name].read,
      write_access: declared[name].write,
      ...(declared[name].rules !== undefined
        ? { rules: declared[name].rules }
        : {}),
      ...(declared[name].unique !== undefined
        ? { unique: declared[name].unique }
        : {}),
      ...(declared[name].indexes !== undefined
        ? { indexes: declared[name].indexes }
        : {}),
    }));
    const differing = wanted.filter((want) => {
      const row = existing.find((r) => r.name === want.name);
      return (
        !row ||
        row.read_access !== want.read_access ||
        row.write_access !== want.write_access ||
        ("rules" in want && (row.rules ?? null) !== want.rules) ||
        ("unique" in want &&
          (row.unique ?? []).join(",") !== (want.unique ?? []).join(",")) ||
        ("indexes" in want &&
          (row.indexes ?? []).join(",") !== (want.indexes ?? []).join(","))
      );
    });
    if (!differing.length) return;
    const created = await object<string[] | null>("configureCollections", {
      ownerId: OWNER,
      collections: differing,
    });
    console.log(
      `_naru/collections.json: ${created?.length ?? 0} created, ${differing.length - (created?.length ?? 0)} changed`,
    );
  } catch (error) {
    console.error(`_naru/collections.json: ${(error as Error).message}`);
  }
}
await installDeclaration();
if (existsSync(join(folder, "_naru")))
  watch(join(folder, "_naru"), { recursive: true }, (_event, name) => {
    if (name === "collections.json") void installDeclaration();
    else if (name) void publish(join(folder, "_naru", name));
  });

/* -------------------------------------------------- sign-in, tokens --- */

const pending = new Map<
  string,
  { challenge: string; redirectUri: string; member?: string }
>();
// Sign-ins outlast restarts of this process, as Naru's do.
const tokensFile = join(state, "tokens.json");
const saved = existsSync(tokensFile)
  ? (JSON.parse(await readFile(tokensFile, "utf8")) as {
      owners: string[];
      members: [string, string][];
    })
  : { owners: [], members: [] };
const owners = new Set<string>(saved.owners);
const memberTokens = new Map<string, string>(saved.members);
const saveTokens = () =>
  writeFile(
    tokensFile,
    JSON.stringify({ owners: [...owners], members: [...memberTokens] }),
  );
const membersFile = join(state, "members.json");
type Members = Record<string, { name: string; status: string }>;
const members = async (): Promise<Members> =>
  existsSync(membersFile)
    ? JSON.parse(await readFile(membersFile, "utf8"))
    : {};
const memberId = (name: string) => {
  const hex = createHash("sha256").update(`${site}:${name}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const digest = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");
const token = () => randomBytes(32).toString("base64url").slice(0, 43);

function redirectWithCode(
  res: ServerResponse,
  query: URLSearchParams,
  member?: string,
) {
  const code = token();
  pending.set(code, {
    challenge: query.get("challenge")!,
    redirectUri: query.get("redirectUri")!,
    member,
  });
  const back = new URL(query.get("redirectUri")!);
  back.searchParams.set("code", code);
  back.searchParams.set("state", query.get("state")!);
  res.writeHead(302, { location: back.href }).end();
}

/**
 * The owner's sign-in: collections it asks for that are missing are made
 * private, as Naru's sign-in page makes them; _naru/collections.json says
 * what they should be.
 */
async function ownerSignIn(res: ServerResponse, query: URLSearchParams) {
  const names = (query.get("collections") ?? "").split(",").filter(Boolean);
  const existing = await object<{ name: string }[]>("collections", {
    names,
  });
  const created = await object<string[] | null>("configureCollections", {
    ownerId: OWNER,
    collections: names
      .filter((name) => !existing.some((row) => row.name === name))
      .map((name) => ({ name, read_access: "admin", write_access: "admin" })),
  });
  console.log(
    `owner signed in: ${names.length} collections, ${created?.length ?? 0} created`,
  );
  redirectWithCode(res, query);
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** A member's sign-in: pick or name a test member, and their status. */
async function memberSignIn(res: ServerResponse, query: URLSearchParams) {
  const name = query
    .getAll("as")
    .find((value) => value.trim())
    ?.trim();
  if (name) {
    const all = await members();
    const id = memberId(name);
    all[id] = {
      name,
      status: query.get("status") ?? all[id]?.status ?? "approved",
    };
    await writeFile(membersFile, JSON.stringify(all, null, 2));
    return redirectWithCode(res, query, id);
  }
  const keep = [...query].filter(([key]) => !["as", "status"].includes(key));
  const hidden = keep
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`,
    )
    .join("");
  const known = Object.values(await members())
    .map(
      (member) =>
        `<button name="as" value="${escape(member.name)}">${escape(member.name)} (${escape(member.status)})</button>`,
    )
    .join(" ");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(`<!doctype html><meta charset="utf-8"><title>naru-dev member sign-in</title>
<body style="font:14px sans-serif;max-width:560px;margin:40px auto">
<h1>${escape(site)} 회원으로 로그인 (naru-dev)</h1>
<form>${hidden}<p>${known || "아직 테스트 회원이 없습니다."}</p>
<p><label>새 테스트 회원 이름 <input name="as"></label>
<select name="status"><option value="approved">approved</option><option value="pending">pending</option><option value="banned">banned</option></select>
<button>로그인</button></p></form>`);
}

/* ------------------------------------------------------------- media --- */

type Upload = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  managed: boolean;
  file: string;
  member: string | null;
};
const uploads = new Map<string, Upload>();
const uploadsFile = join(state, "uploads.json");
if (existsSync(uploadsFile))
  for (const upload of JSON.parse(
    await readFile(uploadsFile, "utf8"),
  ) as Upload[])
    uploads.set(upload.id, upload);
const saveUploads = () =>
  writeFile(uploadsFile, JSON.stringify([...uploads.values()], null, 2));
// Uploads get the address they would have on Naru, so an app checks them as
// it would there; a service worker on the site's pages serves them from here.
const MEDIA_ORIGIN = "https://media.naru.pub";
const mediaUrl = (upload: Upload) => `${MEDIA_ORIGIN}/${OWNER}/${upload.file}`;
const serviceWorker = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === ${JSON.stringify(MEDIA_ORIGIN)})
    event.respondWith(fetch("/media" + url.pathname));
});`;

/** Deletes uploads the site's object let go of (references, ctx.media.delete). */
async function drainMedia() {
  const ids = await object<string[]>("mediaReleases", { limit: 100 });
  if (!ids.length) return;
  for (const id of ids) {
    const upload = uploads.get(id);
    if (upload) await rm(join(mediaDir, upload.file), { force: true });
    uploads.delete(id);
  }
  await saveUploads();
  await object("releasedMedia", { ids });
  console.log(`deleted ${ids.length} released upload(s)`);
}

async function executeMedia(
  method: string,
  path: string[],
  body: Record<string, unknown> | undefined,
  who: { member: string | null },
) {
  if (method === "POST" && !path.length) {
    const name = String(body?.name ?? "upload");
    const id = randomUUID();
    const extension = name.includes(".")
      ? name
          .split(".")
          .pop()!
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 10)
      : "";
    uploads.set(id, {
      id,
      name,
      contentType: String(body?.contentType ?? "application/octet-stream"),
      size: Number(body?.size ?? 0),
      managed: body?.managed === true,
      file: `${id}${extension ? `.${extension}` : ""}`,
      member: who.member,
    });
    return {
      id,
      uploadUrl: `${origin}/_naru-dev/upload/${id}`,
      headers: { "Content-Type": String(body?.contentType) },
    };
  }
  const upload = uploads.get(path[0]);
  if (!upload || (who.member && upload.member !== who.member))
    throw new DataError(404, "File not found.");
  if (method === "PUT") {
    if (upload.managed)
      await object("manageMedia", { ownerId: OWNER, id: upload.id });
    await saveUploads();
    return {
      file: {
        id: upload.id,
        name: upload.name,
        contentType: upload.contentType,
        size: upload.size,
        url: mediaUrl(upload),
      },
    };
  }
  if (method === "DELETE") {
    await rm(join(mediaDir, upload.file), { force: true });
    uploads.delete(upload.id);
    await saveUploads();
    return { success: true };
  }
  throw new DataError(405, "Method not allowed.");
}

/* ------------------------------------------------- data API, signed --- */

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
const json = (res: ServerResponse, status: number, value: unknown) =>
  res
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(value));
const failure = (res: ServerResponse, error: unknown) => {
  if (error instanceof DataError)
    return json(res, error.status, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.site ? { site: true } : {}),
      },
    });
  console.error(error);
  return json(res, 500, { error: { message: "naru-dev failed." } });
};

/** A request carrying an owner's or member's token: the control plane's part. */
async function signed(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string[],
) {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const member = bearer ? (memberTokens.get(bearer) ?? null) : null;
  const owner = bearer ? owners.has(bearer) : false;
  if (bearer && !owner && !member)
    throw new DataError(401, "Sign-in is invalid or expired.", "AUTH_REQUIRED");
  if (member) {
    const status = (await members())[member]?.status ?? "approved";
    if (status !== "approved")
      throw new DataError(403, `Membership is ${status}.`, "ACCESS_DENIED", {
        membership: status,
      });
  }
  const raw = await readBody(req);
  const body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
  const method = req.method!;
  if (path[0] === "_files")
    return json(
      res,
      method === "POST" ? 201 : 200,
      await executeMedia(method, path.slice(1), body, { member }),
    );
  if (path[0] === "_batch") {
    if (!owner) throw new DataError(403, "A batch needs an owner sign-in.");
    const result = await object("batch", {
      ownerId: OWNER,
      allowedIds: null,
      operations: body?.operations,
    });
    await drainMedia();
    return json(res, 201, publicResult(result));
  }
  if (path[0] === "_call") {
    const { file, fn } = functionReference(path.slice(1).join("/"));
    const { mediaReleases, ...answer } = await object<{
      result: unknown;
      written: string[];
      mediaReleases?: number;
    }>("call", {
      ownerId: OWNER,
      site,
      member,
      ...(owner || member ? {} : { visitor: true }),
      file,
      name: fn,
      args: body?.args ?? null,
    });
    if (mediaReleases) await drainMedia();
    return json(res, 200, answer);
  }
  if (path[0] === "_live") {
    if (!member) throw new DataError(403, "Live tickets are for members.");
    return json(res, 200, {
      ticket: await signLiveTicket(secret, site, member),
    });
  }
  const { result } = await object<{ result: unknown }>("execute", {
    ownerId: OWNER,
    site,
    access: { admin: owner, allowedIds: null, anonymous: false, member },
    path,
    method,
    body,
    filter: parseFilterQuery(url.searchParams.get("filter")),
    where: parseWhereQuery(url.searchParams.get("where")),
    size: url.searchParams.has("size")
      ? Number(url.searchParams.get("size"))
      : undefined,
    sort: url.searchParams.get("sort") ?? undefined,
    after: url.searchParams.get("after") ?? undefined,
    includeTotal: url.searchParams.get("includeTotal") === "1",
    ids: url.searchParams.get("ids") ?? undefined,
    ifVersion: websiteCondition(url),
  });
  if (method !== "GET") await drainMedia();
  return json(res, method === "POST" ? 201 : 200, publicResult(result));
}

/* ----------------------------------------------- site files, the SDK --- */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ts": "text/plain; charset=utf-8",
};
// Pages import the SDK from naru.pub (sdk.naru.pub serves the same files);
// the map sends both to this server, as one module, and the service worker
// serves uploads from it.
const importMap = `<script>navigator.serviceWorker?.register("/_naru-dev/media-worker.js",{scope:"/"})</script><script type="importmap">${JSON.stringify(
  {
    imports: Object.fromEntries(
      ["1", "1.0.0", "1.1.0"].flatMap((version) =>
        ["https://sdk.naru.pub", "https://naru.pub"].map((host) => [
          `${host}/sdk/${version}/naru.js`,
          `${origin}/sdk/${version}/naru.js`,
        ]),
      ),
    ),
  },
)}</script>`;

async function sdk(res: ServerResponse, path: string) {
  const match = /^\/sdk\/(1|1\.0\.0|1\.1\.0)\/(naru\.js|naru\.d\.ts)$/.exec(
    path,
  );
  if (!match) return res.writeHead(404).end();
  const version = match[1] === "1" ? "1.0.0" : match[1];
  const source = (
    await readFile(join(root, "public/sdk", version, match[2]), "utf8")
  )
    .replaceAll("https://sdk.naru.pub", origin)
    .replaceAll("https://naru.pub", origin)
    // Pages here are the site's own, as on <site>.naru.pub.
    .replace(
      "site ||= /^([a-z0-9-]+)\\.naru\\.pub$/.exec(",
      `site ||= "${site}" || /^([a-z0-9-]+)\\.naru\\.pub$/.exec(`,
    );
  res
    .writeHead(200, {
      "content-type": TYPES[extname(match[2])] ?? "text/plain",
      "cache-control": "no-store",
    })
    .end(source);
}

async function page(res: ServerResponse, path: string) {
  let file = resolve(folder, `.${decodeURIComponent(path)}`);
  if (!file.startsWith(folder) || file.includes(`${sep}.naru-dev`))
    return res.writeHead(404).end();
  if (existsSync(file) && (await stat(file)).isDirectory())
    file = join(file, "index.html");
  else if (!existsSync(file) && existsSync(`${file}.html`))
    file = `${file}.html`;
  if (!existsSync(file)) return res.writeHead(404).end("Not found.");
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  let content: Buffer | string = await readFile(file);
  if (type.startsWith("text/html")) {
    const text = content.toString("utf8");
    content = /<head[^>]*>/i.test(text)
      ? text.replace(/<head[^>]*>/i, (head) => `${head}${importMap}`)
      : importMap + text;
  }
  res
    .writeHead(200, { "content-type": type, "cache-control": "no-store" })
    .end(content);
}

/* ------------------------------------------------------------ server --- */

/** Sends a request on to the Worker unchanged, as Cloudflare would. */
async function toWorker(req: IncomingMessage, res: ServerResponse, url: URL) {
  const body = ["GET", "HEAD"].includes(req.method!)
    ? undefined
    : await readBody(req);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (typeof value === "string" && key !== "host") headers.set(key, value);
  const answer = await fetch(`${workerUrl}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body,
  });
  // fetch has already decoded the body, so its encoding headers no longer apply.
  const headersOut = Object.fromEntries(
    [...answer.headers].filter(
      ([key]) =>
        !["content-encoding", "content-length", "transfer-encoding"].includes(
          key,
        ),
    ),
  );
  res.writeHead(answer.status, headersOut);
  res.end(Buffer.from(await answer.arrayBuffer()));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, origin);
  try {
    if (url.pathname.startsWith("/sdk/")) return await sdk(res, url.pathname);
    if (url.pathname === "/database/authorize")
      return await ownerSignIn(res, url.searchParams);
    if (url.pathname === "/members/sign-in")
      return await memberSignIn(res, url.searchParams);
    if (
      req.method === "POST" &&
      ["/api/data-auth/v1/token", "/api/data-auth/v1/member-token"].includes(
        url.pathname,
      )
    ) {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const grant = pending.get(body.code);
      pending.delete(body.code);
      if (
        !grant ||
        grant.challenge !== digest(body.verifier) ||
        grant.redirectUri !== body.redirectUri
      )
        throw new DataError(
          401,
          "The sign-in could not be completed.",
          "AUTH_REQUIRED",
        );
      const issued = grant.member ? `m.${token()}` : token();
      if (grant.member) memberTokens.set(issued, grant.member);
      else owners.add(issued);
      await saveTokens();
      return json(res, 200, {
        accessToken: issued,
        expiresIn: 7 * 86400,
        ...(grant.member ? { memberId: grant.member } : {}),
      });
    }
    if (url.pathname.startsWith("/api/data-auth/v1/"))
      return json(res, 200, { success: true });
    if (url.pathname === "/_naru-dev/media-worker.js")
      return res
        .writeHead(200, {
          "content-type": "text/javascript",
          "service-worker-allowed": "/",
        })
        .end(serviceWorker);
    if (url.pathname.startsWith("/_naru-dev/upload/") && req.method === "PUT") {
      const upload = uploads.get(url.pathname.split("/").pop()!);
      if (!upload) return res.writeHead(404).end();
      await writeFile(join(mediaDir, upload.file), await readBody(req));
      return res.writeHead(200).end();
    }
    if (url.pathname.startsWith(`/media/${OWNER}/`)) {
      const upload = [...uploads.values()].find(
        (row) => row.file === url.pathname.split("/").pop(),
      );
      if (!upload || !existsSync(join(mediaDir, upload.file)))
        return res.writeHead(404).end();
      return res
        .writeHead(200, { "content-type": upload.contentType })
        .end(await readFile(join(mediaDir, upload.file)));
    }
    const api = /^\/api\/data\/v1\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (api) {
      if (api[1] !== site)
        throw new DataError(404, `naru-dev serves only ${site}.`);
      const path = (api[2] ?? "")
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      // As on Naru: the edge answers visitors itself; a sign-in, media and
      // batches go to the control plane, here this process.
      if (
        !req.headers.authorization &&
        !["_files", "_batch", "_live"].includes(path[0] ?? "")
      )
        return await toWorker(req, res, url);
      return await signed(req, res, url, path);
    }
    return await page(res, url.pathname);
  } catch (error) {
    return failure(res, error);
  }
});

// Live connections: the WebSocket goes through to the Worker untouched.
server.on("upgrade", (req, socket, head) => {
  const upstream = connect(workerPort, "127.0.0.1", () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers)
          .map(([key, value]) =>
            key === "host"
              ? `host: 127.0.0.1:${workerPort}`
              : `${key}: ${value}`,
          )
          .join("\r\n") +
        "\r\n\r\n",
    );
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(port, () =>
  console.log(
    `naru-dev: ${site} at ${origin}/ (owner and member sign-in are one click; data in ${relative(process.cwd(), state) || state})`,
  ),
);
