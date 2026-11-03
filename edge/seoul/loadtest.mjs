// How much the mini's Data SDK takes: serves seoul/dist (pnpm build:seoul) as
// the mini does, the router (router.capnp) in front of workerd shards
// (config.capnp's Worker, each with its own site databases), seeds sites and
// drives them, on this machine and never on the mini. It reports:
//
// - each kind of request and a mix, at rising concurrency, across all sites,
//   across sites as unevenly busy as real ones (Zipf), and at one popular site;
// - what a slow statement costs the sites on its shard, and those on another;
// - what the disk and memory cost per site, and a site's first request after
//   a restart;
// - how long the five-minute backup's copy takes (infra's
//   kr-seongsu-m4/bin/backup-naru-sites.zsh, without the upload).
//
//   node seoul/loadtest.mjs [--sites 1000] [--docs 100] [--shards 4] \
//     [--seconds 8] [--concurrency 4,16,64,256] [--idle 30] [--out result.json] \
//     [--post-ceiling 60] [--only read,mix] [--keep]
//
// With npm's workerd, or NARU_WORKERD_BIN set to Naru's own (seoul/workerd/),
// as smoke.mjs. Its config differs from the mini's in two ways, both for
// seeding: the test operations are open, and the site bucket is one this
// script serves (SITE_BUCKET_URL), so a site's first call reads its code from
// here rather than R2. Requests reach the router directly: Caddy, TLS and the
// network are not measured, nor is the control plane, which requests with a
// token go through first (here they call the shard as it does afterwards).
//
// Load is closed-loop: each of `concurrency` callers sends its next request
// when the last is answered, so past saturation latency grows and throughput
// stays. Each request has its own address, as a crowd has, so the per-address
// limits stay out of the way; the per-site ones are real, and what they refuse
// is counted apart from errors.
import { execFile, spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { Agent, createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { performance } from "node:perf_hooks";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { shardOf } from "../src/shards.ts";
import {
  fromEnvironment,
  modulesOf,
  siteDataConfig,
} from "./workerd-config.mjs";

const SECRET = "loadtest-secret";
const OWNER = "1";

/** One request of a kind at a site, as a visitor or the control plane sends it. */
function requestOf(kind, site, docs) {
  const n = Math.floor(Math.random() * docs);
  const visitor = {
    Host: "sdk.naru.pub",
    Origin: "https://loadtest.example",
    "CF-Connecting-IP": `10.${(Math.random() * 256) | 0}.${(Math.random() * 256) | 0}.${(Math.random() * 256) | 0}`,
  };
  const operation = (name, input) => ({
    method: "POST",
    path: `/v1/sites/${site}/${name}`,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  switch (kind) {
    case "read":
      return {
        method: "GET",
        path: `/api/data/v1/${site}/posts/d${n}`,
        headers: visitor,
      };
    case "list":
      return {
        method: "GET",
        path: `/api/data/v1/${site}/posts?limit=20`,
        headers: visitor,
      };
    case "query":
      return {
        method: "POST",
        path: `/api/data/v1/${site}/_query/notes:recent`,
        headers: { ...visitor, "Content-Type": "application/json" },
        body: '{"args":{}}',
      };
    case "write":
      // An owner's write, after the control plane has checked the token.
      return operation("execute", {
        ownerId: OWNER,
        site,
        access: { admin: true, allowedIds: null, anonymous: false },
        path: ["posts", `d${n}`],
        method: "PUT",
        body: {
          data: { title: `written ${Date.now()}`, body: "x".repeat(200) },
        },
      });
    case "mutation":
      // A member's mutation, likewise; each caller a new member, so that the
      // per-member limit stays out of the way as the per-address ones do.
      return operation("call", {
        ownerId: OWNER,
        site,
        member: crypto.randomUUID(),
        file: "notes",
        name: "add",
        args: { text: "x".repeat(100) },
        kind: "mutation",
      });
    default:
      throw new Error(`No such kind: ${kind}`);
  }
}

/* ------------------------------------------------- the load's threads --- */

if (!isMainThread) {
  const {
    port,
    shardPorts,
    weights,
    sites,
    zipf,
    docs,
    concurrency,
    warmupMs,
    seconds,
  } = workerData;
  // Given the shards' ports, requests go straight to the site's shard.
  const portOf = (site) =>
    shardPorts ? shardPorts[shardOf(site, shardPorts.length)] : port;
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency });
  const kinds = Object.entries(weights);
  const totalWeight = kinds.reduce((sum, [, weight]) => sum + weight, 0);
  const kindOf = () => {
    let at = Math.random() * totalWeight;
    for (const [kind, weight] of kinds) if ((at -= weight) < 0) return kind;
    return kinds[0][0];
  };
  // The cumulative weight of each site, when they are unevenly busy.
  const siteOf = () => {
    if (!zipf) return sites[Math.floor(Math.random() * sites.length)];
    const at = Math.random();
    let low = 0;
    let high = zipf.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (zipf[middle] < at) low = middle + 1;
      else high = middle;
    }
    return sites[low];
  };
  const failures = {};
  const send = (port, { method, path, headers, body }) =>
    new Promise((done) => {
      const outgoing = httpRequest(
        {
          agent,
          host: "127.0.0.1",
          port,
          method,
          path,
          headers: {
            ...headers,
            ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => done(response.statusCode));
          response.on("error", () => done(0));
        },
      );
      outgoing.on("error", (error) => {
        failures[error.code ?? error.message] =
          (failures[error.code ?? error.message] ?? 0) + 1;
        done(0);
      });
      outgoing.end(body);
    });

  const latencies = Object.fromEntries(kinds.map(([kind]) => [kind, []]));
  const statuses = {};
  const started = performance.now();
  const measuring = started + warmupMs;
  const ending = measuring + seconds * 1000;
  const caller = async () => {
    while (performance.now() < ending) {
      const kind = kindOf();
      const sentAt = performance.now();
      const site = siteOf();
      const status = await send(portOf(site), requestOf(kind, site, docs));
      const answeredAt = performance.now();
      if (sentAt < measuring || answeredAt > ending) continue;
      statuses[status] = (statuses[status] ?? 0) + 1;
      if (status >= 200 && status < 300)
        latencies[kind].push(answeredAt - sentAt);
    }
  };
  const before = performance.eventLoopUtilization();
  await Promise.all(Array.from({ length: concurrency }, caller));
  const { utilization } = performance.eventLoopUtilization(before);
  agent.destroy();
  parentPort.postMessage({ latencies, statuses, failures, utilization });
} else {
  await main();
}

/* -------------------------------------------------------- the machine --- */

async function main() {
  const { values: options } = parseArgs({
    options: {
      sites: { type: "string", default: "1000" },
      docs: { type: "string", default: "100" },
      shards: { type: "string", default: "4" },
      seconds: { type: "string", default: "8" },
      concurrency: { type: "string", default: "4,16,64,256" },
      idle: { type: "string", default: "30" },
      "post-ceiling": { type: "string", default: "60" },
      out: { type: "string" },
      only: { type: "string" },
      keep: { type: "boolean", default: false },
    },
  });
  const SITES = Number(options.sites);
  const DOCS = Number(options.docs);
  const SHARDS = Number(options.shards);
  const SECONDS = Number(options.seconds);
  const IDLE = Number(options.idle);
  const POST_CEILING = Number(options["post-ceiling"]);
  const LEVELS = options.concurrency.split(",").map(Number);
  const THREADS = 4;

  const edge = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dist = join(edge, "seoul/dist");
  const workerd =
    process.env.NARU_WORKERD_BIN ?? join(edge, "node_modules/.bin/workerd");
  const budget = process.env.NARU_WORKERD_BIN
    ? { WORKERD_SQLITE_STATEMENT_TIMEOUT_MS: "3000" }
    : {};
  const root = await mkdtemp(join(tmpdir(), "naru-loadtest-"));
  const logPath = join(root, "workerd.log");
  const log = createWriteStream(logPath);
  await new Promise((done) => log.once("open", done));

  const freePort = () =>
    new Promise((done) => {
      const server = createNetServer().listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => done(port));
      });
    });

  // The site bucket, as naru-dev serves one (edge/src/http-bucket.ts).
  const objects = new Map();
  const bucket = createServer(async (request, response) => {
    const url = new URL(request.url, "http://bucket");
    if (url.pathname === "/list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const listed = [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({
          key,
          size: value.length,
          etag: String(value.length),
          uploaded: new Date().toISOString(),
        }));
      response.setHeader("Content-Type", "application/json");
      return response.end(
        JSON.stringify({ objects: listed, truncated: false }),
      );
    }
    const key = decodeURIComponent(url.pathname.replace(/^\/objects\//, ""));
    if (request.method === "PUT") {
      if (request.headers["if-none-match"] === "*" && objects.has(key)) {
        response.statusCode = 412;
        return response.end();
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      response.setHeader("ETag", String(objects.get(key).length));
      return response.end();
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      return response.end();
    }
    const found = objects.get(key);
    if (!found) {
      response.statusCode = 404;
      return response.end();
    }
    response.setHeader("ETag", String(found.length));
    response.setHeader("Last-Modified", new Date().toUTCString());
    response.end(found);
  });
  await new Promise((done) => bucket.listen(0, "127.0.0.1", done));
  const bucketUrl = `http://127.0.0.1:${bucket.address().port}/`;

  // The shards' config: the mini's bindings, with what seeding needs besides.
  await writeFile(
    join(dist, "loadtest.capnp"),
    siteDataConfig({
      header: "# Written by seoul/loadtest.mjs.",
      modules: await modulesOf(join(dist, "worker"), "seoul.js", "worker/"),
      bindings: [
        `      (name = "TEST_OPERATIONS", text = "1"),`,
        fromEnvironment("SITE_BUCKET_URL"),
        fromEnvironment("EDGE_WORKER_SECRET"),
        fromEnvironment("PASSTHROUGH_ORIGIN"),
        fromEnvironment(
          "SQLITE_STATEMENT_TIMEOUT_MS",
          "WORKERD_SQLITE_STATEMENT_TIMEOUT_MS",
        ),
        fromEnvironment("NARU_SDK_SHARD"),
        fromEnvironment("NARU_SDK_SHARD_ORIGINS"),
        fromEnvironment("NARU_SDK_SHARD_OVERRIDES"),
      ],
      sdkFiles: "sdk-files",
      siteObjects: "site-objects",
      uniqueKey: "naru-site-data",
    }),
  );

  const routerPort = await freePort();
  const shardPorts = [];
  for (let i = 0; i < SHARDS; i++) shardPorts.push(await freePort());
  const origins = shardPorts
    .map((port) => `http://127.0.0.1:${port}`)
    .join(",");
  const router = `http://127.0.0.1:${routerPort}`;
  const shardDir = (i) => join(root, "site-objects", `shard-${i}`);

  const processes = new Map();
  const launch = (name, args, env) => {
    const child = spawn(workerd, ["serve", ...args], {
      cwd: dist,
      env: {
        ...budget,
        ...process.env,
        NARU_SDK_SHARD_ORIGINS: origins,
        NARU_SDK_SHARD_OVERRIDES: "{}",
        ...env,
      },
      stdio: ["ignore", log, log],
    });
    processes.set(name, child);
  };
  const answering = async (origin) => {
    for (let tries = 0; ; tries++) {
      try {
        if ((await fetch(`${origin}/healthz`)).ok) return;
      } catch {
        if (tries > 100) throw new Error(`${origin} did not start: ${logPath}`);
        await new Promise((done) => setTimeout(done, 100));
      }
    }
  };
  const startShard = async (i) => {
    await mkdir(shardDir(i), { recursive: true });
    launch(
      `shard-${i}`,
      [
        "loadtest.capnp",
        "--directory-path",
        `site-objects=${shardDir(i)}`,
        "--socket-addr",
        `http=127.0.0.1:${shardPorts[i]}`,
      ],
      {
        NARU_SDK_SHARD: String(i),
        EDGE_WORKER_SECRET: SECRET,
        PASSTHROUGH_ORIGIN: "http://127.0.0.1:9",
        SITE_BUCKET_URL: bucketUrl,
      },
    );
    await answering(`http://127.0.0.1:${shardPorts[i]}`);
  };
  const stopProcess = async (name) => {
    const child = processes.get(name);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGKILL");
    await exited;
  };

  // Each process's CPU time and memory, from ps.
  const seconds = (time) =>
    time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  const sample = async () => {
    const pids = new Map(
      [...processes].map(([name, child]) => [String(child.pid), name]),
    );
    const { stdout } = await promisify(execFile)("ps", [
      "-o",
      "pid=,time=,rss=",
      "-p",
      [...pids.keys()].join(","),
    ]);
    const seen = {};
    for (const line of stdout.trim().split("\n")) {
      const [pid, time, rss] = line.trim().split(/\s+/);
      seen[pids.get(pid)] = { cpu: seconds(time), rssMb: Number(rss) / 1024 };
    }
    return seen;
  };
  const rssTotal = (seen) =>
    Object.entries(seen)
      .filter(([name]) => name.startsWith("shard"))
      .reduce((sum, [, process]) => sum + process.rssMb, 0);

  // Straight to the shard: seeding is not what is measured.
  const operate = async (site, operation, input) => {
    const shard = shardPorts[shardOf(site, SHARDS)];
    const response = await fetch(
      `http://127.0.0.1:${shard}/v1/sites/${site}/${operation}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${operation} of ${site}: ${response.status} ${text}`);
    return text;
  };
  const inParallel = async (items, concurrency, work) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < items.length) await work(items[next++]);
      }),
    );
  };
  const percentile = (sorted, p) =>
    sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
      : null;
  const summary = (values) => {
    const sorted = Float64Array.from(values).sort();
    const round = (value) => (value === null ? null : Number(value.toFixed(2)));
    return {
      p50: round(percentile(sorted, 0.5)),
      p95: round(percentile(sorted, 0.95)),
      p99: round(percentile(sorted, 0.99)),
      max: round(sorted.at(-1) ?? null),
    };
  };

  /** One closed-loop run, across the threads, with what it cost the shards. */
  async function drive({
    weights,
    sites,
    zipf,
    concurrency,
    seconds: length,
    direct = false,
  }) {
    const threads = Math.min(THREADS, concurrency);
    const warmupMs = 1000;
    const before = await sample();
    const startedAt = performance.now();
    const results = await Promise.all(
      Array.from({ length: threads }, (_, index) => {
        const worker = new Worker(fileURLToPath(import.meta.url), {
          workerData: {
            port: routerPort,
            shardPorts: direct ? shardPorts : null,
            weights,
            sites,
            zipf,
            docs: DOCS,
            warmupMs,
            seconds: length,
            concurrency:
              Math.floor(concurrency / threads) +
              (index < concurrency % threads ? 1 : 0),
          },
        });
        return new Promise((done, fail) => {
          worker.once("message", done);
          worker.once("error", fail);
        });
      }),
    );
    const elapsed = (performance.now() - startedAt) / 1000;
    const after = await sample();
    const statuses = {};
    const failures = {};
    const byKind = {};
    for (const result of results) {
      for (const [failure, count] of Object.entries(result.failures))
        failures[failure] = (failures[failure] ?? 0) + count;
      for (const [status, count] of Object.entries(result.statuses))
        statuses[status] = (statuses[status] ?? 0) + count;
      for (const [kind, values] of Object.entries(result.latencies))
        (byKind[kind] ??= []).push(...values);
    }
    const all = Object.values(byKind).flat();
    const count = (test) =>
      Object.entries(statuses)
        .filter(([status]) => test(Number(status)))
        .reduce((sum, [, value]) => sum + value, 0);
    const cores = (name) =>
      Number(((after[name].cpu - before[name].cpu) / elapsed).toFixed(2));
    const shardNames = Object.keys(after).filter((name) =>
      name.startsWith("shard"),
    );
    return {
      concurrency,
      requestsPerSecond: Math.round(all.length / length),
      latencyMs: summary(all),
      byKind: Object.fromEntries(
        Object.entries(byKind).map(([kind, values]) => [
          kind,
          {
            requestsPerSecond: Math.round(values.length / length),
            ...summary(values),
          },
        ]),
      ),
      refusedPerSecond: Math.round(count((s) => s === 429) / length),
      errorsPerSecond: Number(
        (count((s) => s !== 429 && (s < 200 || s >= 300)) / length).toFixed(1),
      ),
      statuses,
      failures,
      busiestShardCores: Math.max(...shardNames.map(cores)),
      shardCores: Number(
        shardNames.reduce((sum, name) => sum + cores(name), 0).toFixed(2),
      ),
      routerCores: cores("router"),
      maxShardRssMb: Math.round(
        Math.max(...shardNames.map((name) => after[name].rssMb)),
      ),
      generatorBusy: Number(
        Math.max(...results.map((result) => result.utilization)).toFixed(2),
      ),
    };
  }
  const line = (name, run) =>
    console.log(
      [
        name.padEnd(16),
        String(run.concurrency).padStart(4),
        `${String(run.requestsPerSecond).padStart(6)}/s`,
        `p50 ${String(run.latencyMs.p50).padStart(7)}`,
        `p99 ${String(run.latencyMs.p99).padStart(7)} ms`,
        `429 ${String(run.refusedPerSecond).padStart(5)}/s`,
        `err ${String(run.errorsPerSecond).padStart(5)}/s`,
        `busiest ${run.busiestShardCores} cores`,
        `router ${run.routerCores}`,
        `rss ${run.maxShardRssMb} MB`,
        ...(run.generatorBusy > 0.9
          ? ["(the load generator is saturated)"]
          : []),
      ].join("  "),
    );

  const sites = Array.from({ length: SITES }, (_, i) => `site${i}`);
  const result = {
    recordedAt: new Date().toISOString(),
    boundary:
      "workerd router and shards over loopback HTTP; no Caddy, TLS, network or control plane; site code from a local bucket",
    machine: {
      model: spawnSync("sysctl", ["-n", "hw.model"]).stdout?.toString().trim(),
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 2 ** 30),
    },
    workerd: process.env.NARU_WORKERD_BIN ? "Naru's" : "npm's",
    node: process.version,
    options: {
      sites: SITES,
      docs: DOCS,
      shards: SHARDS,
      seconds: SECONDS,
      levels: LEVELS,
    },
  };
  const save = () =>
    options.out
      ? writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`)
      : null;

  try {
    await Promise.all(shardPorts.map((_, i) => startShard(i)));
    launch("router", [
      "router.capnp",
      "--socket-addr",
      `http=127.0.0.1:${routerPort}`,
    ]);
    await answering(router);

    /* ------------------------------------------------------- seeding --- */

    console.log(`Seeding ${SITES} sites, ${DOCS} documents each, in ${root}…`);
    const seedingAt = performance.now();
    // Site SQL has no recursive queries, so the rows are spelled out.
    const NOTES = Array.from(
      { length: 1000 },
      (_, i) => `('note ${i}', ${i})`,
    ).join(", ");
    const seed = async (site) => {
      await operate(site, "configure", {
        ownerId: OWNER,
        entitledUntil: null,
        confirmedUntil: Date.now() + 10 * 365 * 86400 * 1000,
        monthlyRequests: null,
      });
      await operate(site, "configureCollections", {
        ownerId: OWNER,
        collections: [
          { name: "posts", read_access: "world", write_access: "admin" },
        ],
      });
      for (let n = 0; n < DOCS; n++)
        await operate(site, "execute", {
          ownerId: OWNER,
          site,
          access: { admin: true, allowedIds: null, anonymous: false },
          path: ["posts", `d${n}`],
          method: "PUT",
          body: { data: { title: `post ${n}`, body: "x".repeat(200) } },
        });
      const put = (folder, file, source, publish = false) =>
        operate(site, "putFunctions", { site, folder, file, source, publish });
      await put(
        "migrations",
        "0001_notes",
        `CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL, author TEXT, created_at INTEGER NOT NULL);
         CREATE INDEX notes_created ON notes (created_at);
         INSERT INTO notes (text, created_at) VALUES ${NOTES};`,
      );
      await put(
        "mutations",
        "notes",
        `export async function add(ctx, { text }) {
          const { rows } = await ctx.sql\`INSERT INTO notes (text, author, created_at)
            VALUES (\${text}, \${ctx.member?.id ?? null}, \${ctx.now}) RETURNING id\`;
          return rows[0].id;
        }`,
      );
      await put(
        "queries",
        "notes",
        `export async function recent(ctx) {
          const { rows } = await ctx.sql\`SELECT id, text, author, created_at FROM notes ORDER BY created_at DESC LIMIT 20\`;
          return rows;
        }
        export async function slow(ctx, { to }) {
          const { rows } = await ctx.sql\`SELECT count(*) AS c FROM (SELECT 1 FROM notes a, notes b, notes c LIMIT \${to})\`;
          return rows[0].c;
        }`,
        true,
      );
    };
    await inParallel(sites, 32, seed);
    const seedSeconds = (performance.now() - seedingAt) / 1000;

    const sqliteFiles = async () =>
      (await readdir(join(root, "site-objects"), { recursive: true }))
        .filter((file) => file.endsWith(".sqlite"))
        .map((file) => join(root, "site-objects", file));
    const files = await sqliteFiles();
    const sizes = await Promise.all(
      files.map(async (file) => (await stat(file)).size),
    );
    const diskBytes = sizes.reduce((sum, size) => sum + size, 0);
    result.seeding = {
      sitesPerSecond: Number((SITES / seedSeconds).toFixed(1)),
      databases: files.length,
      diskMb: Math.round(diskBytes / 2 ** 20),
      diskKbPerSite: Math.round(diskBytes / files.length / 1024),
    };
    console.log(result.seeding);

    /* ------------------------------------------- the ladder of loads --- */

    // Each site's share of the traffic, as 1/rank of it.
    const harmonic = sites.reduce((sum, _, i) => sum + 1 / (i + 1), 0);
    let running = 0;
    const zipf = sites.map((_, i) => (running += 1 / (i + 1) / harmonic));
    const MIX = { read: 70, list: 12, query: 12, write: 3, mutation: 3 };
    // Through the router, as requests come; "direct" straight to the shards,
    // which shows what the router itself costs.
    const scenarios = [
      ["read", { read: 1 }, sites],
      ["list", { list: 1 }, sites],
      ["mix", MIX, sites],
      ["read one site", { read: 1 }, [sites[0]]],
      ["read direct", { read: 1 }, sites, null, true],
      ["query direct", { query: 1 }, sites, null, true],
      ["write direct", { write: 1 }, sites, null, true],
      ["mutation direct", { mutation: 1 }, sites, null, true],
      ["mix direct", MIX, sites, null, true],
      ["zipf mix direct", MIX, sites, zipf, true],
      ["one site mix direct", MIX, [sites[0]], null, true],
    ];
    result.scenarios = {};
    const chosen = options.only?.split(",");
    for (const [name, weights, targets, weighted, direct] of scenarios) {
      if (chosen && !chosen.includes(name)) continue;
      result.scenarios[name] = [];
      for (const concurrency of LEVELS) {
        const run = await drive({
          weights,
          sites: targets,
          zipf: weighted,
          concurrency,
          seconds: SECONDS,
          direct,
        });
        result.scenarios[name].push(run);
        line(name, run);
        await save();
      }
    }

    /* ------------------------------------- the router's POST ceiling --- */

    // For each non-GET, the router first asks the shard whether it is up
    // (`listening` in src/router.ts). When that was a socket of its own, each
    // closed one held an ephemeral port in TIME_WAIT, and past (ports /
    // TIME_WAIT) a second the machine had none left. Long enough to see it,
    // should it come back.
    const ports = (name) =>
      Number(spawnSync("sysctl", ["-n", name]).stdout?.toString().trim() ?? 0);
    const ephemeral =
      ports("net.inet.ip.portrange.last") -
      ports("net.inet.ip.portrange.first") +
      1;
    if (POST_CEILING > 0) {
      const drain = () => new Promise((done) => setTimeout(done, 35_000));
      await drain();
      const run = await drive({
        weights: { query: 1 },
        sites,
        concurrency: 16,
        seconds: POST_CEILING,
      });
      result.routerPostCeiling = {
        ephemeralPorts: ephemeral,
        seconds: POST_CEILING,
        requestsPerSecond: run.requestsPerSecond,
        latencyMs: run.latencyMs,
        statuses: run.statuses,
        failures: run.failures,
      };
      console.log(result.routerPostCeiling);
      await save();
      await drain();
    }

    /* ------------------------------------------------ noisy neighbour --- */

    // Sites this far apart in the name space, by the router's own hash.
    const on = (shard, skip = 0) =>
      sites.filter((site) => shardOf(site, SHARDS) === shard)[skip];
    // Each site may read 5M rows a minute (ROWS_PER_MINUTE in site.ts), which
    // stops one site well short of filling its shard: the slow calls take
    // turns among the shard's other sites, as many busy sites would.
    const sameShard = on(0, 0);
    const noisy = sites.filter(
      (site) => shardOf(site, SHARDS) === 0 && site !== sameShard,
    );
    const otherShard = on(1, 0);
    const victims = async () => {
      const [same, other] = await Promise.all(
        [sameShard, otherShard].map((site) =>
          drive({
            weights: { read: 1 },
            sites: [site],
            concurrency: 4,
            seconds: Math.max(SECONDS, 10),
          }),
        ),
      );
      return { sameShard: same, otherShard: other };
    };
    const quiet = await victims();
    const slowCalls = [];
    const refusals = {};
    let keepSlow = true;
    let slowTurn = 0;
    const slowLoop = (async () => {
      while (keepSlow) {
        const at = performance.now();
        const response = await fetch(
          `${router}/api/data/v1/${noisy[slowTurn++ % noisy.length]}/_query/notes:slow`,
          {
            method: "POST",
            headers: {
              Host: "sdk.naru.pub",
              "Content-Type": "application/json",
              "CF-Connecting-IP": "10.9.9.9",
            },
            body: JSON.stringify({ args: { to: 450_000 } }),
          },
        );
        if (response.ok) {
          await response.text();
          slowCalls.push(performance.now() - at);
        } else {
          const reason = `${response.status} ${(await response.text()).slice(0, 200)}`;
          refusals[reason] = (refusals[reason] ?? 0) + 1;
          await new Promise((done) => setTimeout(done, 100));
        }
      }
    })();
    const loud = await victims();
    keepSlow = false;
    await slowLoop;
    const victim = (run) => ({
      requestsPerSecond: run.requestsPerSecond,
      latencyMs: run.latencyMs,
    });
    result.noisyNeighbour = {
      slowQuery: { calls: slowCalls.length, ...summary(slowCalls), refusals },
      quiet: {
        sameShard: victim(quiet.sameShard),
        otherShard: victim(quiet.otherShard),
      },
      loud: {
        sameShard: victim(loud.sameShard),
        otherShard: victim(loud.otherShard),
      },
    };
    console.log(JSON.stringify(result.noisyNeighbour, null, 2));
    await save();

    /* --------------------------------- memory, and the first request --- */

    const shardNames = shardPorts.map((_, i) => `shard-${i}`);
    await Promise.all(shardNames.map(stopProcess));
    await Promise.all(shardPorts.map((_, i) => startShard(i)));
    await new Promise((done) => setTimeout(done, 1000));
    const fresh = rssTotal(await sample());
    const firstRequests = [];
    await inParallel(sites, 16, async (site) => {
      const at = performance.now();
      const response = await fetch(
        `${router}/api/data/v1/${site}/_query/notes:recent`,
        {
          method: "POST",
          headers: {
            Host: "sdk.naru.pub",
            "Content-Type": "application/json",
            "CF-Connecting-IP": "10.8.8.8",
          },
          body: '{"args":{}}',
        },
      );
      await response.text();
      if (response.ok) firstRequests.push(performance.now() - at);
    });
    const touched = rssTotal(await sample());
    await new Promise((done) => setTimeout(done, IDLE * 1000));
    const rested = rssTotal(await sample());
    result.sitesInMemory = {
      freshShardsRssMb: Math.round(fresh),
      afterEverySiteRssMb: Math.round(touched),
      kbPerSite: Math.round(((touched - fresh) * 1024) / SITES),
      [`after${IDLE}sIdleRssMb`]: Math.round(rested),
      firstRequest: {
        answered: firstRequests.length,
        ...summary(firstRequests),
      },
    };
    console.log(result.sitesInMemory);
    await save();

    /* ------------------------------------------------ the backup copy --- */

    // backup-naru-sites.zsh, one database after another, then the archive.
    const target = join(root, "backup");
    await mkdir(target);
    const databases = await sqliteFiles();
    const copyAt = performance.now();
    databases.forEach((file, index) => {
      const copied = spawnSync("/usr/bin/sqlite3", [
        "-cmd",
        ".timeout 15000",
        file,
        `.backup '${join(target, `${index}.sqlite`)}'`,
      ]);
      if (copied.status !== 0)
        throw new Error(`The backup of ${file}: ${copied.stderr}`);
    });
    const archiveAt = performance.now();
    const archive = join(root, "backup.tar.gz");
    spawnSync("/usr/bin/tar", ["-czf", archive, "-C", target, "."]);
    const doneAt = performance.now();
    const copySeconds = (archiveAt - copyAt) / 1000;
    const archiveSeconds = (doneAt - archiveAt) / 1000;
    result.backup = {
      databases: databases.length,
      copySeconds: Number(copySeconds.toFixed(1)),
      archiveSeconds: Number(archiveSeconds.toFixed(1)),
      archiveMb: Math.round((await stat(archive)).size / 2 ** 20),
      // The most sites a five-minute round has time for, at this rate.
      sitesInFiveMinutes: Math.round(
        (databases.length * 300) / (copySeconds + archiveSeconds),
      ),
    };
    console.log(result.backup);
    await save();
  } catch (error) {
    console.error(`Failed; workerd's log is ${logPath}`);
    process.exitCode = 1;
    throw error;
  } finally {
    await Promise.all([...processes.keys()].map(stopProcess));
    bucket.close();
    log.end();
    await rm(join(dist, "loadtest.capnp"), { force: true });
    if (options.keep) console.log(`Kept ${root}`);
    else if (!process.exitCode)
      await rm(root, { recursive: true, force: true });
  }
}
