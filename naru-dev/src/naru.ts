// A local Naru for one site. It runs the real edge Worker (edge/src/seoul.ts,
// as the mini runs it, under workerd with SQLite-backed Durable Objects), so
// collections, the site's tables, queries, mutations, routes, live queries
// and limits behave as on Naru. This process stands in for the control plane
// around it: it serves the site's files and the SDK (pointed at itself),
// signs owners and members in on one click, answers the requests that carry
// a sign-in, keeps uploads and the site bucket (where `_naru/` is published
// from) in folders, and republishes `_naru/` whenever a file there changes.
//
// Not emulated: payments, quotas of the control plane (media size), custom
// domains, the mini's SQLite step budget, and anything of naru.pub beyond
// the site's own API.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { parseFilterQuery } from "../../control-plane/src/lib/site-data/filters";
import {
  OWNER_TICKET,
  signLiveTicket,
} from "../../control-plane/src/lib/site-data/live-ticket";
import {
  CALLS,
  publicResult,
  websiteCondition,
} from "../../control-plane/src/lib/site-data/protocol";
import {
  DataError,
  functionReference,
} from "../../control-plane/src/lib/site-data/validation";
import {
  matchRoute,
  routeAnswer,
  routeOf,
  validRoute,
  withHead,
} from "../../control-plane/src/lib/site-functions/routes";
import type * as Api from "./api";

/** Where the parts naru-dev runs are: built into the package, or a checkout's. */
export interface Resources {
  /** The Worker's bundle and config.capnp (scripts/build-worker.mjs). */
  workerDir: string;
  /** The SDK's files: <version>/naru.js and its types. */
  sdkDir: string;
  /** The workerd binary. */
  workerd: string;
}

const OWNER = "1";
const SITE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FOLDERS = [
  "modules",
  "migrations",
  "queries",
  "mutations",
  "routes",
] as const;
// Uploads get the address they would have on Naru, so an app checks them as
// it would there; a service worker on the site's pages serves them from here.
const MEDIA_ORIGIN = "https://media.naru.pub";
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
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".ts": "text/plain; charset=utf-8",
};

type Upload = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  file: string;
  member: string | null;
};
type Members = Record<string, { name: string; status: string }>;

const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
    probe.on("error", fail);
  });

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
const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** `path`, relative to the working directory when that is shorter. */
const shortest = (path: string) => {
  const near = relative(process.cwd(), path) || ".";
  return near.length < path.length ? near : path;
};

/** Files under `dir`, recursively, that `_naru/` publishes. */
async function files(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (/\.(m?js|sql)$/.test(entry.name)) found.push(path);
  }
  return found;
}

export async function start(
  options: Api.StartOptions,
  resources: Resources,
): Promise<Api.Naru> {
  const folder = resolve(options.site);
  const site = options.name ?? "localsite";
  if (!SITE_NAME.test(site))
    throw new TypeError(
      "The site's name is a Naru login name: lowercase letters, digits, hyphens.",
    );
  if (!existsSync(folder)) throw new Error(`There is no folder ${folder}.`);
  const madeState = !options.state;
  const state = options.state
    ? resolve(options.state)
    : await mkdtemp(join(tmpdir(), "naru-dev-"));
  const mediaDir = join(state, "media", OWNER);
  const bucketDir = join(state, "bucket");
  await mkdir(mediaDir, { recursive: true });

  let output = "";
  const log = (line: string) => {
    output += `${line}\n`;
    if (!options.quiet) console.log(line);
  };
  const warn = (line: string) => {
    output += `${line}\n`;
    if (!options.quiet) console.error(line);
  };

  const secret = randomBytes(24).toString("base64url");
  let origin = "";
  let workerUrl = "";
  let workerPort = 0;
  let ready!: () => void;
  const started = new Promise<void>((done) => (ready = done));

  /* --------------------------------------------- the site bucket --- */

  // Where `_naru/` is published from, as R2 is on Naru: the Worker reads and
  // writes it here (edge/src/http-bucket.ts), with the secret.
  const bucketPath = (key: string) => {
    const path = resolve(bucketDir, key);
    if (!path.startsWith(bucketDir + sep))
      throw new DataError(400, "Invalid key.");
    return path;
  };
  async function bucketKeys(dir: string): Promise<string[]> {
    if (!existsSync(dir)) return [];
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await bucketKeys(path)));
      else if (!entry.name.endsWith(".naru-dev-partial")) found.push(path);
    }
    return found;
  }
  async function bucket(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.headers.authorization !== `Bearer ${secret}`)
      return res.writeHead(401).end();
    const rest = url.pathname.slice("/_naru-dev/bucket/".length);
    if (rest === "list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const objects = [];
      for (const path of (await bucketKeys(bucketDir)).sort()) {
        const key = relative(bucketDir, path).split(sep).join("/");
        if (!key.startsWith(prefix)) continue;
        const info = await stat(path);
        objects.push({
          key,
          size: info.size,
          etag: `${info.size}-${info.mtimeMs}`,
          uploaded: info.mtime.toISOString(),
        });
      }
      return json(res, 200, { objects, truncated: false });
    }
    if (!rest.startsWith("objects/")) return res.writeHead(404).end();
    const key = rest
      .slice("objects/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const path = bucketPath(key);
    if (req.method === "GET") {
      if (!existsSync(path)) return res.writeHead(404).end();
      const content = await readFile(path);
      const info = await stat(path);
      return res
        .writeHead(200, {
          etag: `${info.size}-${info.mtimeMs}`,
          "content-length": content.length,
        })
        .end(content);
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      if (req.headers["if-none-match"] === "*" && existsSync(path))
        return res.writeHead(412).end();
      await mkdir(dirname(path), { recursive: true });
      // Whole or not at all, as R2 writes.
      await writeFile(`${path}.naru-dev-partial`, body);
      await rename(`${path}.naru-dev-partial`, path);
      return res.writeHead(200).end();
    }
    if (req.method === "DELETE") {
      await rm(path, { force: true });
      return res.writeHead(204).end();
    }
    return res.writeHead(405).end();
  }

  /* ------------------------------------------------ the edge Worker --- */

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

  let worker: ChildProcess | null = null;
  let stopping = false;
  async function startWorker() {
    workerPort = await freePort();
    workerUrl = `http://127.0.0.1:${workerPort}`;
    const objects = join(state, "worker", "v3", "do");
    await mkdir(objects, { recursive: true });
    const child = spawn(
      resources.workerd,
      [
        "serve",
        join(resources.workerDir, "config.capnp"),
        "--directory-path",
        `site-objects=${objects}`,
        "--directory-path",
        `sdk-files=${resources.sdkDir}`,
        "--socket-addr",
        `http=127.0.0.1:${workerPort}`,
      ],
      {
        cwd: resources.workerDir,
        env: {
          ...process.env,
          EDGE_WORKER_SECRET: secret,
          PASSTHROUGH_ORIGIN: origin.replace("localhost", "127.0.0.1"),
          SITE_BUCKET_URL: `${origin.replace("localhost", "127.0.0.1")}/_naru-dev/bucket/`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    worker = child;
    // workerd outlives this process otherwise, however it ends.
    const orphaned = () => child.kill();
    process.on("exit", orphaned);
    child.once("exit", () => process.off("exit", orphaned));
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n"))
        // The config is the mini's, which names the flag for older workerd.
        if (
          line.trim() &&
          !/compatibility flag nodejs_compat became/.test(line)
        )
          warn(line);
    };
    child.stdout!.on("data", relay);
    child.stderr!.on("data", relay);
    let exited: number | null | undefined;
    child.once("exit", (code) => {
      exited = code;
      if (!stopping) warn(`naru-dev: the edge Worker stopped (${code}).`);
    });
    for (let tries = 0; ; tries++) {
      if (exited !== undefined)
        throw new Error(`The edge Worker exited (${exited}):\n${output}`);
      try {
        if ((await fetch(`${workerUrl}/healthz`)).ok) break;
      } catch {
        /* not yet */
      }
      if (tries > 300) throw new Error("The edge Worker did not start.");
      await new Promise((done) => setTimeout(done, 100));
    }
  }

  /* -------------------------------------------- _naru/ publication --- */

  /**
   * Publishes one `_naru/<folder>/<path>.js` (or a migration's `.sql`), or
   * removes it when gone.
   */
  async function publish(path: string, publishing = true) {
    const inside = relative(join(folder, "_naru"), path).split(sep);
    const kind = inside[0] as (typeof FOLDERS)[number];
    if (
      !FOLDERS.includes(kind) ||
      !(kind === "migrations" ? /\.sql$/ : /\.m?js$/).test(path)
    )
      return;
    const file = inside
      .slice(1)
      .join("/")
      .replace(/\.(m?js|sql)$/, "");
    const source = existsSync(path) ? await readFile(path, "utf8") : null;
    try {
      await object("putFunctions", {
        site,
        folder: kind,
        file,
        source,
        publish: publishing,
      });
      if (publishing) {
        log(`published _naru/ (${kind}/${file} changed)`);
        await writeTypes();
      }
    } catch (error) {
      warn(`_naru/${kind}/${file}: ${(error as Error).message}`);
    }
  }

  /**
   * `_naru/types/database.d.ts`: the site's tables as their migrations left
   * them, an interface each and a `Database` map, for ctx.sql and any query
   * builder. Columns follow SQLite's type affinity.
   */
  async function writeTypes() {
    const tables = await object<
      {
        name: string;
        view: boolean;
        columns: { name: string; type: string; nullable: boolean }[];
      }[]
    >("siteTables", {});
    const typeOf = (declared: string) => {
      const type = declared.toUpperCase();
      if (type.includes("INT")) return "number";
      if (/CHAR|CLOB|TEXT/.test(type)) return "string";
      if (type.includes("BLOB") || !type) return "unknown";
      return "number";
    };
    const pascal = (name: string) =>
      name
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join("")
        .replace(/^(?=\d)/, "T");
    const key = (name: string) =>
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
    const body = [
      "// Written by naru dev from the site's tables: do not edit.",
      "",
      ...tables.flatMap((table) => [
        `/** ${table.view ? "View" : "Table"} ${table.name}. */`,
        `export interface ${pascal(table.name)} {`,
        ...table.columns.map(
          (column) =>
            `  ${key(column.name)}: ${typeOf(column.type)}${column.nullable ? " | null" : ""};`,
        ),
        "}",
        "",
      ]),
      "export interface Database {",
      ...tables.map((table) => `  ${key(table.name)}: ${pascal(table.name)};`),
      "}",
      "",
    ].join("\n");
    const path = join(folder, "_naru", "types", "database.d.ts");
    if (existsSync(path) && (await readFile(path, "utf8")) === body) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    log("wrote _naru/types/database.d.ts");
  }

  /**
   * `_naru/collections.json`, the collections the site declares, installed
   * as Naru installs it when the file arrives
   * (lib/site-data/declared-collections.ts): here every declared setting is
   * applied at once, changes to existing collections included, since the
   * one running naru-dev is the owner.
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
          unique?: string[];
          indexes?: string[];
        }[]
      >("collections", { names });
      const wanted = names.map((name) => ({
        name,
        read_access: declared[name].read,
        write_access: declared[name].write,
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
      log(
        `_naru/collections.json: ${created?.length ?? 0} created, ${differing.length - (created?.length ?? 0)} changed`,
      );
    } catch (error) {
      warn(`_naru/collections.json: ${(error as Error).message}`);
    }
  }

  /** The site as Naru holds it: paid for, `_naru/` published, declared. */
  async function install() {
    // Paid for ten years, as far as the object knows, so it answers visitors.
    await object("configure", {
      ownerId: OWNER,
      entitledUntil: null,
      confirmedUntil: Date.now() + 10 * 365 * 86400 * 1000,
      monthlyRequests: null,
    });
    // Every file first, then one publication: modules import each other.
    const everything = (
      await Promise.all(
        FOLDERS.map((kind) => files(join(folder, "_naru", kind))),
      )
    ).flat();
    for (const [index, path] of everything.entries())
      await publish(path, index === everything.length - 1);
    await installDeclaration();
    // Every upload kept here, as ctx.media.get reads them (Naru records
    // them as the owner opens the media library).
    await recordUploads([...uploads.values()], true);
  }

  /* ------------------------------------------------ sign-in, tokens --- */

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
  const members = async (): Promise<Members> =>
    existsSync(membersFile)
      ? JSON.parse(await readFile(membersFile, "utf8"))
      : {};
  const memberId = (name: string) => {
    const hex = createHash("sha256").update(`${site}:${name}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  /** Keeps a test member, as Naru keeps a site's members; returns its id. */
  async function keepMember(name: string, status?: string | null) {
    const all = await members();
    const id = memberId(name);
    all[id] = { name, status: status ?? all[id]?.status ?? "approved" };
    await writeFile(membersFile, JSON.stringify(all, null, 2));
    return id;
  }
  const digest = (verifier: string) =>
    createHash("sha256").update(verifier).digest("base64url");
  const token = () => randomBytes(32).toString("base64url").slice(0, 43);
  const LIFETIME = 7 * 86400;
  /** A new access token for the owner, or for the member `member`. */
  async function issue(member?: string) {
    const issued = member ? `m.${token()}` : token();
    if (member) memberTokens.set(issued, member);
    else owners.add(issued);
    await saveTokens();
    return issued;
  }

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
   * The collections the owner's sign-in asks for that are missing, made
   * private, as Naru's sign-in page makes them; _naru/collections.json says
   * what they should be.
   */
  async function ownerCollections(names: string[]) {
    const existing = await object<{ name: string }[]>("collections", {
      names,
    });
    const created = await object<string[] | null>("configureCollections", {
      ownerId: OWNER,
      collections: names
        .filter((name) => !existing.some((row) => row.name === name))
        .map((name) => ({
          name,
          read_access: "admin",
          write_access: "admin",
        })),
    });
    log(
      `owner signed in: ${names.length} collections, ${created?.length ?? 0} created`,
    );
  }

  async function ownerSignIn(res: ServerResponse, query: URLSearchParams) {
    await ownerCollections(
      (query.get("collections") ?? "").split(",").filter(Boolean),
    );
    redirectWithCode(res, query);
  }

  /** A member's sign-in: pick or name a test member, and their status. */
  async function memberSignIn(res: ServerResponse, query: URLSearchParams) {
    const name = query
      .getAll("as")
      .find((value) => value.trim())
      ?.trim();
    if (name)
      return redirectWithCode(
        res,
        query,
        await keepMember(name, query.get("status")),
      );
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

  /* ------------------------------------------------------------ media --- */

  const uploads = new Map<string, Upload>();
  const uploadsFile = join(state, "uploads.json");
  if (existsSync(uploadsFile))
    for (const upload of JSON.parse(
      await readFile(uploadsFile, "utf8"),
    ) as Upload[])
      uploads.set(upload.id, upload);
  const saveUploads = () =>
    writeFile(uploadsFile, JSON.stringify([...uploads.values()], null, 2));
  const mediaUrl = (upload: Upload) =>
    `${MEDIA_ORIGIN}/${OWNER}/${upload.file}`;
  /** Tells the site's object of uploads, for ctx.media.get (media.ts). */
  async function recordUploads(list: Upload[], all = false) {
    for (let at = 0; at < list.length; at += 1000)
      await object("recordMedia", {
        files: list.slice(at, at + 1000).map((upload) => ({
          id: upload.id,
          url: mediaUrl(upload),
          member: upload.member,
          name: upload.name,
          type: upload.contentType,
          size: upload.size,
        })),
      });
    if (all)
      await object("recordMedia", {
        files: [],
        keep: list.map((upload) => upload.id),
      });
  }
  const serviceWorker = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === ${JSON.stringify(MEDIA_ORIGIN)})
    event.respondWith(fetch("/media" + url.pathname));
});`;

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
      await saveUploads();
      await recordUploads([upload]);
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
      await object("forgetMedia", { ids: [upload.id] });
      return { success: true };
    }
    throw new DataError(405, "Method not allowed.");
  }

  /* ------------------------------------------------- data API, signed --- */

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
    warn(String((error as Error)?.stack ?? error));
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
      throw new DataError(
        401,
        "Sign-in is invalid or expired.",
        "AUTH_REQUIRED",
      );
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
      return json(res, 201, publicResult(result));
    }
    if (Object.hasOwn(CALLS, path[0])) {
      const { file, fn } = functionReference(path.slice(1).join("/"));
      const { result } = await object<{ result: unknown }>("call", {
        ownerId: OWNER,
        site,
        member,
        ...(owner || member ? {} : { visitor: true }),
        file,
        name: fn,
        args: body?.args ?? null,
        kind: CALLS[path[0] as keyof typeof CALLS],
        // The browser's session ID (ctx.session), as its SDK sends it.
        ...(typeof req.headers["naru-session"] === "string"
          ? { session: req.headers["naru-session"] }
          : {}),
      });
      return json(res, 200, { result });
    }
    if (path[0] === "_live") {
      if (!member && !owner)
        throw new DataError(403, "Live tickets are for members and the owner.");
      return json(res, 200, {
        ticket: await signLiveTicket(secret, site, member ?? OWNER_TICKET),
      });
    }
    if (member)
      throw new DataError(
        403,
        "Members reach a site's data through its queries and mutations, not its collections.",
        "ACCESS_DENIED",
      );
    const { result } = await object<{ result: unknown }>("execute", {
      ownerId: OWNER,
      site,
      access: { admin: owner, allowedIds: null, anonymous: false },
      path,
      method,
      body,
      filter: parseFilterQuery(url.searchParams.get("filter")),
      size: url.searchParams.has("size")
        ? Number(url.searchParams.get("size"))
        : undefined,
      sort: url.searchParams.get("sort") ?? undefined,
      after: url.searchParams.get("after") ?? undefined,
      includeTotal: url.searchParams.get("includeTotal") === "1",
      ifVersion: websiteCondition(url),
    });
    return json(res, method === "POST" ? 201 : 200, publicResult(result));
  }

  /* ----------------------------------------------- site files, the SDK --- */

  const sdkVersions = (await readdir(resources.sdkDir))
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .sort();
  // Pages import the SDK from sdk.naru.pub (older pages from naru.pub, which
  // no longer serves it); the map sends both to this server, as one module,
  // and the service worker serves uploads from it.
  let importMap = "";
  const withImportMap = (html: string) =>
    /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (head) => `${head}${importMap}`)
      : importMap + html;

  async function sdk(res: ServerResponse, path: string) {
    const match =
      /^\/sdk\/(\d+(?:\.\d+\.\d+)?)\/(naru\.js|naru\.d\.ts|functions\.d\.ts)$/.exec(
        path,
      );
    // "1" is 1.0.0, as on Naru.
    const version = match?.[1] === "1" ? "1.0.0" : match?.[1];
    if (!match || !sdkVersions.includes(version!))
      return res.writeHead(404).end();
    const file = join(resources.sdkDir, version!, match[2]);
    // 1.0.0 has no functions.d.ts.
    if (!existsSync(file)) return res.writeHead(404).end();
    const source = (await readFile(file, "utf8"))
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

  /**
   * A path one of `_naru/routes/` answers (1.1.0), rendered by the site's
   * object as Naru's edge renders it; false when no route matches.
   */
  async function route(res: ServerResponse, url: URL) {
    const routes = (await files(join(folder, "_naru", "routes")))
      .map((path) =>
        routeOf(relative(join(folder, "_naru"), path).split(sep).join("/")),
      )
      .filter(validRoute);
    const match = matchRoute(routes, url.pathname);
    if (!match) return false;
    const html = (status: number, body: string, headers = {}) =>
      res
        .writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          ...headers,
        })
        .end(withImportMap(body));
    try {
      const { result } = await object<{ result: unknown }>("render", {
        site,
        route: match.route,
        path: url.pathname,
        origin: url.origin,
        params: match.params,
        query: Object.fromEntries(url.searchParams),
      });
      const answer = routeAnswer(result);
      if ("redirect" in answer)
        res.writeHead(answer.status, { location: answer.redirect }).end();
      else if ("html" in answer) html(answer.status, answer.html);
      else if ("body" in answer)
        res
          .writeHead(answer.status, {
            "content-type": `${answer.type}; charset=utf-8`,
            "cache-control": "no-store",
          })
          .end(answer.body);
      else {
        let file = resolve(folder, answer.file);
        if (existsSync(file) && (await stat(file)).isDirectory())
          file = join(file, "index.html");
        if (!file.startsWith(folder) || !existsSync(file))
          html(404, `The route's file ${answer.file} is not there.`);
        else
          html(
            answer.status,
            withHead(await readFile(file, "utf8"), answer.head),
          );
      }
    } catch (error) {
      const status = error instanceof DataError ? error.status : 500;
      html(status, `<p>${(error as Error).message.replace(/</g, "&lt;")}</p>`);
    }
    return true;
  }

  async function page(res: ServerResponse, path: string) {
    let file = resolve(folder, `.${decodeURIComponent(path)}`);
    if (
      !(file === folder || file.startsWith(folder + sep)) ||
      relative(folder, file).split(sep).includes(".naru-dev") ||
      file.startsWith(state + sep)
    )
      return res.writeHead(404).end();
    if (existsSync(file) && (await stat(file)).isDirectory())
      file = join(file, "index.html");
    else if (!existsSync(file) && existsSync(`${file}.html`))
      file = `${file}.html`;
    if (!existsSync(file)) return res.writeHead(404).end("Not found.");
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    let content: Buffer | string = await readFile(file);
    if (type.startsWith("text/html"))
      content = withImportMap(content.toString("utf8"));
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

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, origin);
    // The Worker's, while it starts too.
    if (url.pathname.startsWith("/_naru-dev/bucket/"))
      return await bucket(req, res, url);
    await started;
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
      return json(res, 200, {
        accessToken: await issue(grant.member),
        expiresIn: LIFETIME,
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
    if (["GET", "HEAD"].includes(req.method!) && (await route(res, url)))
      return;
    return await page(res, url.pathname);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => failure(res, error));
  });
  // Live connections: the WebSocket goes through to the Worker untouched.
  // Upgraded sockets are the server's no more: stop() ends them itself.
  const live = new Set<{ destroy(): void }>();
  server.on("upgrade", (req, socket, head) => {
    live.add(socket);
    socket.once("close", () => live.delete(socket));
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

  const port = await new Promise<number>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 0, () => {
      server.off("error", fail);
      done((server.address() as { port: number }).port);
    });
  });
  origin = `http://localhost:${port}`;
  importMap = `<script>navigator.serviceWorker?.register("/_naru-dev/media-worker.js",{scope:"/"})</script><script type="importmap">${JSON.stringify(
    {
      imports: Object.fromEntries(
        ["1", ...sdkVersions].flatMap((version) =>
          ["https://sdk.naru.pub", "https://naru.pub"].map((host) => [
            `${host}/sdk/${version}/naru.js`,
            `${origin}/sdk/${version}/naru.js`,
          ]),
        ),
      ),
    },
  )}</script>`;

  let watcher: FSWatcher | null = null;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    watcher?.close();
    const closed = new Promise((done) => server.close(done));
    server.closeAllConnections();
    for (const socket of live) socket.destroy();
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = new Promise((done) => worker!.once("exit", done));
      worker.kill();
      await exited;
    }
    await closed;
    if (madeState) await rm(state, { recursive: true, force: true });
  };

  try {
    await startWorker();
    await install();
  } catch (error) {
    await stop();
    throw error;
  }
  if (existsSync(join(folder, "_naru")))
    watcher = watch(
      join(folder, "_naru"),
      { recursive: true },
      (_event, name) => {
        if (!name) return;
        const file = name.toString();
        if (file === "collections.json") void installDeclaration();
        else void publish(join(folder, "_naru", file));
      },
    );
  ready();
  log(
    `naru-dev: ${site} at ${origin}/ (owner and member sign-in are one click; data in ${shortest(state)})`,
  );

  return {
    origin,
    name: site,
    state,
    get log() {
      return output;
    },
    url: (path = "/") => new URL(path, origin).href,
    async signIn(target, who, signInOptions = {}) {
      if (typeof who !== "string" || !who.trim())
        throw new TypeError('who is "owner" or a member\'s name.');
      const member =
        who === "owner"
          ? undefined
          : await keepMember(who.trim(), signInOptions.status);
      if (!member && signInOptions.collections)
        await ownerCollections(signInOptions.collections);
      const accessToken = await issue(member);
      const credentials: Api.Credentials = {
        accessToken,
        expiresAt: Date.now() + LIFETIME * 1000,
        ...(member ? { memberId: member } : {}),
        headers: { authorization: `Bearer ${accessToken}` },
      };
      if (target) {
        // Where the SDK keeps each (1.0.0 and 1.1.0 alike): the owner's per
        // tab and page, in sessionStorage; a member's per site, in
        // localStorage. Each sign-in is put there once per tab and page, so a
        // later one wins and a sign-out in the page sticks.
        const script = `(() => {
  const s = ${JSON.stringify({
    origin,
    site,
    owner: !member,
    id: randomUUID(),
    session: {
      accessToken,
      expiresAt: credentials.expiresAt,
      ...(member ? { memberId: member } : {}),
    },
  })};
  try {
    if (location.origin !== s.origin) return;
    const store = s.owner ? sessionStorage : localStorage;
    const key = s.owner
      ? "naru:owner:" + s.origin + ":" + s.site + ":" + location.origin + location.pathname
      : "naru:member:" + s.origin + ":" + s.site;
    const mark = "naru-dev:signed-in:" + s.id + ":" + (s.owner ? location.pathname : "");
    if (sessionStorage.getItem(mark)) return;
    sessionStorage.setItem(mark, "1");
    store.setItem(key, JSON.stringify(s.session));
  } catch {}
})();`;
        await target.addInitScript(script);
        const here = typeof target.url === "function" ? target.url() : "";
        if (typeof target.evaluate === "function" && here.startsWith(origin))
          await target.evaluate(script);
      }
      return credentials;
    },
    async reset() {
      await object("erase", {});
      uploads.clear();
      await saveUploads();
      await rm(mediaDir, { recursive: true, force: true });
      await mkdir(mediaDir, { recursive: true });
      await install();
    },
    stop,
  };
}
