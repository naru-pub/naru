// Serves seoul/dist (pnpm build:seoul) as the mini does since it was
// sharded (README.md, "Shards"): the router (router.capnp) in front of two
// shards (config.capnp, each with its own site databases), all with workerd,
// and checks what only that can break: each site's requests reaching the
// shard that holds it and no other, live connections and NDJSON streams
// through the router both ways without being held, visitors' headers kept,
// the fan-outs, a restarting shard waited for, and a stuck shard holding up
// only its own sites. It prints what the router adds to a request.
//
//   node seoul/smoke-shards.mjs
//
// With npm's workerd, or NARU_WORKERD_BIN, as smoke.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shardOf } from "../src/shards.ts";

const edge = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(edge, "seoul/dist");
const workerd =
  process.env.NARU_WORKERD_BIN ?? join(edge, "node_modules/.bin/workerd");
const budget = process.env.NARU_WORKERD_BIN
  ? { WORKERD_SQLITE_STATEMENT_TIMEOUT_MS: "3000" }
  : {};
const objects = await mkdtemp(join(tmpdir(), "naru-shards-"));
const secret = "smoke-secret";
const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
const SHARDS = 2;
const routerPort = await freePort();
const shardPorts = [];
for (let i = 0; i < SHARDS; i++) shardPorts.push(await freePort());
const router = `http://127.0.0.1:${routerPort}`;
const shardOrigin = (i) => `http://127.0.0.1:${shardPorts[i]}`;
const origins = shardPorts.map((_, i) => shardOrigin(i)).join(",");

// The control plane, as the Worker passes requests on to it: what reached
// it, and a streamed answer, sent a piece at a time.
const passed = [];
const control = createHttpServer(async (request, response) => {
  const seen = {
    url: request.url,
    headers: request.headers,
    chunks: [],
  };
  passed.push(seen);
  for await (const chunk of request)
    seen.chunks.push({ at: Date.now(), text: chunk.toString() });
  response.writeHead(200, { "Content-Type": "application/x-ndjson" });
  response.write('{"part":1}\n');
  await new Promise((done) => setTimeout(done, 600));
  response.end('{"part":2}\n');
});
await new Promise((done) => control.listen(0, "127.0.0.1", done));
const controlOrigin = `http://127.0.0.1:${control.address().port}`;

const processes = new Map();
function launch(name, args, env) {
  const child = spawn(workerd, ["serve", ...args], {
    cwd: dist,
    env: {
      ...budget,
      ...process.env,
      NARU_SDK_SHARD_ORIGINS: origins,
      NARU_SDK_SHARD_OVERRIDES: "{}",
      ...env,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  processes.set(name, child);
  return child;
}
async function answering(origin) {
  for (let tries = 0; ; tries++) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) return;
    } catch {
      if (tries > 100) throw new Error(`${origin} did not start.`);
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}
const shardDir = (i) => join(objects, `shard-${i}`);
async function startShard(i) {
  await mkdir(shardDir(i), { recursive: true });
  launch(
    `shard-${i}`,
    [
      "config.capnp",
      "--directory-path",
      `site-objects=${shardDir(i)}`,
      "--socket-addr",
      `http=127.0.0.1:${shardPorts[i]}`,
    ],
    {
      NARU_SDK_SHARD: String(i),
      EDGE_WORKER_SECRET: secret,
      PASSTHROUGH_ORIGIN: controlOrigin,
      R2_ACCOUNT_ID: "unused",
      R2_ACCESS_KEY_ID: "unused",
      R2_SECRET_ACCESS_KEY: "unused",
      R2_BUCKET: "unused",
    },
  );
  await answering(shardOrigin(i));
}
async function stop(name) {
  const child = processes.get(name);
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await exited;
}

// Sites on each shard, by the hash the router uses.
const sitesOn = (shard, count) => {
  const found = [];
  for (let n = 0; found.length < count; n++)
    if (shardOf(`site${n}`, SHARDS) === shard) found.push(`site${n}`);
  return found;
};
const [alpha, gamma] = sitesOn(0, 2);
const [beta, delta] = sitesOn(1, 2);

// A request with a body, named when it fails: undici's error says what went
// wrong, not which request. (Those without one fail here on purpose: polling a
// shard before it starts, the stuck shard.)
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  try {
    return await realFetch(url, init);
  } catch (error) {
    if (init?.body != null)
      console.error(
        `${init?.method ?? "GET"} ${url} failed: ${error.cause?.code ?? error}`,
      );
    throw error;
  }
};

async function operate(site, operation, input, base = router) {
  const response = await fetch(`${base}/v1/sites/${site}/${operation}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { text };
  }
  return { status: response.status, ...body };
}
const visit = (path, init = {}, base = router) =>
  fetch(`${base}/api/data/v1/${path}`, {
    ...init,
    headers: {
      Host: "sdk.naru.pub",
      Origin: "https://a.example",
      ...init.headers,
    },
  });
const owner = {
  ownerId: "1",
  access: { admin: true, allowedIds: null, anonymous: false },
};
async function seed(site, title) {
  assert.equal(
    (
      await operate(site, "configure", {
        ownerId: "1",
        entitledUntil: null,
        confirmedUntil: Date.now() + 86_400_000,
      })
    ).status,
    200,
  );
  const created = await operate(site, "configureCollections", {
    ownerId: "1",
    collections: [
      { name: "posts", read_access: "world", write_access: "admin" },
    ],
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  const written = await operate(site, "execute", {
    ...owner,
    site,
    path: ["posts", "one"],
    method: "PUT",
    body: { data: { title } },
  });
  assert.equal(written.status, 200, JSON.stringify(written));
}
// Each read from its own address: a visitor's reads a minute are limited.
let visitor = 0;
const titleOf = async (site, base = router) => {
  visitor += 1;
  const read = await visit(
    `${site}/posts/one`,
    {
      headers: {
        "CF-Connecting-IP": `10.${(visitor >> 16) & 255}.${(visitor >> 8) & 255}.${visitor & 255}`,
      },
    },
    base,
  );
  assert.equal(read.status, 200, `${site} through ${base}`);
  return (await read.json()).document.data.title;
};
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
async function timed(task) {
  const start = performance.now();
  await task();
  return performance.now() - start;
}

try {
  for (let i = 0; i < SHARDS; i++) await startShard(i);
  launch(
    "router",
    ["router.capnp", "--socket-addr", `http=127.0.0.1:${routerPort}`],
    {},
  );
  await answering(router);

  assert.equal(await (await fetch(`${router}/healthz`)).text(), "ok");
  assert.equal(
    await (await fetch(`${router}/healthz/deep`)).text(),
    "ok",
    "every shard opens a site database",
  );
  const sdk = await fetch(`${router}/sdk/1/naru.js`);
  assert.equal(sdk.status, 200, "the router serves the SDK's files");
  assert.match(await sdk.text(), /createNaru/);
  assert.equal((await fetch(`${router}/`)).status, 404);

  // Each site lands on its own shard, and only there.
  await seed(alpha, "alpha's");
  await seed(beta, "beta's");
  assert.equal(await titleOf(alpha), "alpha's");
  assert.equal(await titleOf(beta), "beta's");
  assert.equal(await titleOf(alpha, shardOrigin(0)), "alpha's");
  assert.equal(await titleOf(beta, shardOrigin(1)), "beta's");
  assert.equal(
    (await visit(`${alpha}/posts/one`, {}, shardOrigin(1))).status,
    421,
    "a shard refuses a site it does not hold",
  );
  assert.equal((await operate(beta, "dump", {}, shardOrigin(0))).status, 421);
  // As naru's containers call, with a name that is not the platform's.
  assert.equal(
    (
      await fetch(
        `http://localhost:${routerPort}/v1/sites/${alpha}/collections`,
        {
          method: "POST",
          headers: {
            Host: "host.docker.internal",
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ownerId: "1" }),
        },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${router}/v1/sites/${alpha}/dump`, {
        method: "POST",
        body: "{}",
      })
    ).status,
    401,
    "site operations need the secret, through the router too",
  );

  // The breakers' unnotified sites, from every shard.
  const unnotified = await fetch(`${router}/v1/breakers/unnotified`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    body: "{}",
  });
  assert.equal(unnotified.status, 200);
  assert.deepEqual(await unnotified.json(), { value: { sites: [] } });
  assert.equal(
    (
      await fetch(`${router}/v1/breakers/unnotified`, {
        method: "POST",
        body: "{}",
      })
    ).status,
    401,
  );

  // A live connection, through the router to beta's shard.
  const socket = new WebSocket(
    `ws://127.0.0.1:${routerPort}/api/data/v1/${beta}/_live`,
  );
  const pong = await new Promise((done, fail) => {
    socket.onopen = () => socket.send("ping");
    socket.onmessage = (event) => done(event.data);
    socket.onerror = () => fail(new Error("The live connection failed."));
    setTimeout(
      () => fail(new Error("No answer on the live connection.")),
      5000,
    );
  });
  assert.equal(pong, "pong");
  socket.close();

  // A site moved across shards, as the control plane moves one: alpha's
  // dump (shard 0) piped into delta's restore (shard 1), both through the
  // router, streamed.
  const dump = await fetch(`${router}/v1/sites/${alpha}/dump`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    body: "{}",
  });
  // Printed for a failure on CI that never reproduced locally (Node 24's
  // fetch once said a request body's length did not match its header).
  console.log(`dump answered with ${JSON.stringify([...dump.headers])}`);
  assert.equal(dump.status, 200);
  assert.equal(dump.headers.get("content-type"), "application/x-ndjson");
  const restored = await fetch(`${router}/v1/sites/${delta}/restore`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-ndjson",
    },
    // A fresh stream, so the request takes no length from the dump's answer
    // (one that came compressed, say, would declare the wrong one).
    body: dump.body.pipeThrough(new TransformStream()),
    duplex: "half",
  });
  const outcome = await restored.json();
  assert.equal(restored.status, 200, JSON.stringify(outcome));
  assert.equal(await titleOf(delta), "alpha's");
  assert.ok(
    existsSync(join(shardDir(1), "naru-site-data")),
    "delta's database is on shard 1",
  );

  // Visitors' headers reach the control plane as Caddy set them, and a body
  // and an answer each pass a piece at a time, held by neither the router
  // nor the shard.
  const pieces = new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode("first,"));
      await new Promise((done) => setTimeout(done, 600));
      controller.enqueue(new TextEncoder().encode("second"));
      controller.close();
    },
  });
  const sent = Date.now();
  const passing = await fetch(
    `${router}/api/data/v1/${gamma}/_files/upload?x=1`,
    {
      method: "POST",
      headers: {
        Host: "sdk.naru.pub",
        Authorization: "Bearer someone",
        "CF-Connecting-IP": "203.0.113.7",
        "X-Forwarded-For": "203.0.113.7",
        "Content-Type": "application/octet-stream",
      },
      body: pieces,
      duplex: "half",
    },
  );
  const reader = passing.body.getReader();
  const first = await reader.read();
  const firstAt = Date.now() - sent;
  let rest = "";
  for (let next; !(next = await reader.read()).done;)
    rest += new TextDecoder().decode(next.value);
  const answeredAt = Date.now() - sent;
  assert.equal(new TextDecoder().decode(first.value), '{"part":1}\n');
  assert.equal(rest, '{"part":2}\n');
  const seen = passed.at(-1);
  assert.equal(seen.url, `/api/data/v1/${gamma}/_files/upload?x=1`);
  assert.equal(seen.headers["cf-connecting-ip"], "203.0.113.7");
  assert.equal(seen.headers["x-forwarded-for"], "203.0.113.7");
  assert.equal(seen.headers.authorization, "Bearer someone");
  assert.equal(seen.chunks.map((chunk) => chunk.text).join(""), "first,second");
  const bodySpread = seen.chunks.at(-1).at - seen.chunks[0].at;
  assert.ok(bodySpread >= 400, `the body streamed (${bodySpread} ms apart)`);
  assert.ok(
    answeredAt - firstAt >= 400,
    `the answer streamed (first piece at ${firstAt} ms, last at ${answeredAt} ms)`,
  );

  // What the router adds: the same read, straight to the shard and through
  // the router, one at a time.
  const direct = [];
  const routed = [];
  for (let round = 0; round < 300; round++) {
    direct.push(await timed(() => titleOf(beta, shardOrigin(1))));
    routed.push(await timed(() => titleOf(beta)));
  }
  const writes = { direct: [], routed: [] };
  for (let round = 0; round < 100; round++) {
    const write = (base) => () =>
      operate(
        beta,
        "execute",
        {
          ...owner,
          site: beta,
          path: ["posts", "one"],
          method: "PUT",
          body: { data: { title: "beta's" } },
        },
        base,
      );
    writes.direct.push(await timed(write(shardOrigin(1))));
    writes.routed.push(await timed(write(router)));
  }
  // The fastest of each series is what the router costs, with the machine's
  // scheduling noise mostly left out; medians on a shared CI runner are not.
  const fastest = (values) => Math.min(...values);
  const overhead = {
    read: fastest(routed) - fastest(direct),
    write: fastest(writes.routed) - fastest(writes.direct),
  };
  console.log(
    `router (medians): a read ${median(direct).toFixed(2)} ms straight, ${median(routed).toFixed(2)} ms routed; ` +
      `a write ${median(writes.direct).toFixed(2)} ms straight, ${median(writes.routed).toFixed(2)} ms routed; ` +
      `added, fastest to fastest: +${overhead.read.toFixed(2)} ms a read, +${overhead.write.toFixed(2)} ms a write`,
  );
  // About 0.1 ms on the mini. The bound only has to catch the router
  // buffering or reconnecting, which costs tens of milliseconds.
  assert.ok(overhead.read < 2, `the router adds ${overhead.read} ms to a read`);
  assert.ok(
    overhead.write < 2,
    `the router adds ${overhead.write} ms to a write`,
  );

  // A stuck shard (its thread held, as by a long statement: here, stopped)
  // holds up its own sites, and nothing else.
  processes.get("shard-0").kill("SIGSTOP");
  const stuck = fetch(`${router}/api/data/v1/${alpha}/posts/one`, {
    signal: AbortSignal.timeout(1500),
  }).then(
    () => "answered",
    () => "waiting",
  );
  const others = [];
  for (let round = 0; round < 20; round++)
    others.push(await timed(() => titleOf(beta)));
  assert.equal(await (await fetch(`${router}/healthz`)).text(), "ok");
  const deepWhileStuck = await fetch(`${router}/healthz/deep`);
  assert.equal(deepWhileStuck.status, 503);
  assert.match(await deepWhileStuck.text(), /shard 0: no answer/);
  assert.equal(await stuck, "waiting", "alpha waits for its shard");
  processes.get("shard-0").kill("SIGCONT");
  assert.equal(await titleOf(alpha), "alpha's");
  console.log(
    `isolation: with shard 0 stuck, beta's reads took ${median(others).toFixed(2)} ms (max ${Math.max(...others).toFixed(2)})`,
  );
  assert.ok(Math.max(...others) < 100, "beta never waited for shard 0");

  // A shard restarting: its sites' requests wait for it, reads and writes
  // alike, as Caddy waits for the router.
  await stop("shard-1");
  const restartedAt = Date.now();
  // Kept, and awaited below: the router can get the requests through before
  // startShard sees /healthz answer, and a startShard still polling when the
  // test stops every process would fail after it.
  const restarting = new Promise((done) => setTimeout(done, 1000)).then(() =>
    startShard(1),
  );
  const [readAfter, writeAfter] = await Promise.all([
    titleOf(beta),
    operate(beta, "execute", {
      ...owner,
      site: beta,
      path: ["posts", "two"],
      method: "PUT",
      body: { data: { title: "after" } },
    }),
  ]);
  await restarting;
  assert.equal(readAfter, "beta's");
  assert.equal(writeAfter.status, 200, JSON.stringify(writeAfter));
  console.log(
    `restart: beta's read and write waited ${Date.now() - restartedAt} ms for shard 1 to come back`,
  );

  console.log(
    `seoul shards: ${process.env.NARU_WORKERD_BIN ? "Naru's" : "npm's"} workerd routes each site to its shard.`,
  );
} finally {
  for (const name of processes.keys()) await stop(name);
  control.close();
  await rm(objects, { recursive: true, force: true });
}
