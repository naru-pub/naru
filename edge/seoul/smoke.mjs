// Serves seoul/dist (pnpm build:seoul) with workerd, as the mini does, and
// checks what only that runtime can break: SQLite objects on local disk across
// a restart, the SDK's files, visitors at sdk.naru.pub, and moving a site
// between objects with `dump` and `restore`, NDJSON streamed both ways. Site functions are left out: their
// sources need the real R2 bucket.
//
//   node seoul/smoke.mjs
//
// With npm's workerd, or with NARU_WORKERD_BIN set to Naru's own
// (seoul/workerd/), as the mini runs it: with its 3-second step budget
// (WORKERD_SQLITE_STATEMENT_TIMEOUT_MS, unless set otherwise).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const edge = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(edge, "seoul/dist");
const workerd =
  process.env.NARU_WORKERD_BIN ?? join(edge, "node_modules/.bin/workerd");
const budget = process.env.NARU_WORKERD_BIN
  ? { WORKERD_SQLITE_STATEMENT_TIMEOUT_MS: "3000" }
  : {};
const objects = await mkdtemp(join(tmpdir(), "naru-seoul-"));
const secret = "smoke-secret";
const port = await new Promise((done) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});
const base = `http://127.0.0.1:${port}`;

let running;
async function start() {
  running = spawn(
    workerd,
    [
      "serve",
      "config.capnp",
      "--directory-path",
      `site-objects=${objects}`,
      "--socket-addr",
      `http=127.0.0.1:${port}`,
    ],
    {
      cwd: dist,
      env: {
        ...budget,
        ...process.env,
        EDGE_WORKER_SECRET: secret,
        PASSTHROUGH_ORIGIN: "http://127.0.0.1:9",
        R2_ACCOUNT_ID: "unused",
        R2_ACCESS_KEY_ID: "unused",
        R2_SECRET_ACCESS_KEY: "unused",
        R2_BUCKET: "unused",
        R2_PRIVATE_BUCKET: "unused",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  for (let tries = 0; ; tries++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      if (tries > 100) throw new Error("workerd did not start.");
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}
async function stop() {
  const exited = new Promise((done) => running.once("exit", done));
  running.kill();
  await exited;
}

/** One site operation, as the control plane calls it (edge/client.ts). */
async function operate(site, operation, input) {
  // As naru's containers reach it, by a name that is not the platform's.
  const response = await fetch(
    `http://localhost:${port}/v1/sites/${site}/${operation}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
  const body = await response.json();
  return { status: response.status, ...body };
}
/** A site's dump, as NDJSON lines parsed (control-plane/src/lib/edge/dumps.ts reads it a chunk at a time). */
async function dumpOf(site) {
  const response = await fetch(`${base}/v1/sites/${site}/dump`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");
  return response;
}
const linesOf = (text) =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
const rowsOf = (lines, table) =>
  lines
    .filter((line) => line.type === "row" && line.table === table)
    .map((line) => line.row);
const visit = (path, init = {}) =>
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

try {
  await start();
  const deep = await fetch(`${base}/healthz/deep`);
  assert.equal(await deep.text(), "ok", "a site database opens");
  const sdk = await fetch(`${base}/sdk/1.1.0/naru.js`, {
    headers: { Host: "sdk.naru.pub" },
  });
  assert.equal(sdk.status, 200);
  const sdkSource = await sdk.text();
  assert.match(sdkSource, /createNaru/);
  assert.match(sdkSource, /const DATA_API = "https:\/\/sdk\.naru\.pub";/);
  // /sdk/1/ is an alias (control-plane/sdk/aliases.json), with its headers.
  const alias = await fetch(`${base}/sdk/1/naru.js`, {
    headers: { Host: "sdk.naru.pub" },
  });
  assert.equal(alias.status, 200);
  assert.match(alias.headers.get("content-type"), /^text\/javascript/);
  assert.equal(alias.headers.get("access-control-allow-origin"), "*");
  assert.match(await alias.text(), /createNaru/);
  assert.equal(
    (await fetch(`${base}/`, { headers: { Host: "alpha.naru.pub" } })).status,
    404,
    "hosted pages stay on Cloudflare",
  );
  assert.equal(
    (
      await fetch(`${base}/v1/sites/alpha/dump`, {
        method: "POST",
        headers: {
          Host: "host.docker.internal",
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    200,
    "naru's containers reach it by host.docker.internal",
  );
  assert.equal(
    (await fetch(`${base}/v1/sites/alpha/dump`, { method: "POST", body: "{}" }))
      .status,
    401,
    "site operations need the secret",
  );
  // The control plane's paused-statement alerts (breaker.ts) reach it too,
  // with the secret only.
  assert.equal(
    (
      await fetch(`${base}/v1/breakers/unnotified`, {
        method: "POST",
        body: "{}",
        headers: { Authorization: `Bearer ${secret}` },
      })
    ).status,
    200,
    "the breaker alerts reach the Worker",
  );
  assert.equal(
    (
      await fetch(`${base}/v1/breakers/unnotified`, {
        method: "POST",
        body: "{}",
      })
    ).status,
    401,
    "breaker operations need the secret",
  );

  const configuration = {
    ownerId: "1",
    entitledUntil: null,
    confirmedUntil: Date.now() + 86_400_000,
  };
  assert.equal(
    (await operate("alpha", "configure", configuration)).status,
    200,
  );
  const created = await operate("alpha", "configureCollections", {
    ownerId: "1",
    collections: [
      {
        name: "posts",
        read_access: "world",
        write_access: "admin",
        unique: ["slug"],
      },
    ],
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  const written = await operate("alpha", "execute", {
    ...owner,
    site: "alpha",
    path: ["posts", "one"],
    method: "PUT",
    body: { data: { title: "first", slug: "a" } },
  });
  assert.equal(written.status, 200, JSON.stringify(written));

  const read = await visit("alpha/posts/one");
  assert.equal(read.status, 200);
  assert.equal((await read.json()).document.data.title, "first");

  // A visitor's live connection, held by the object (hibernation API); its
  // keepalive is answered without waking it.
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/data/v1/alpha/_live`,
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

  // Move alpha's database into beta, as the cutover moves each site: one
  // object's dump piped straight into the other's restore.
  const restore = (site, body) =>
    fetch(`${base}/v1/sites/${site}/restore`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-ndjson",
      },
      body,
      duplex: "half",
    });
  const piped = await restore("beta", (await dumpOf("alpha")).body);
  const restored = await piped.json();
  assert.equal(piped.status, 200, JSON.stringify(restored));
  assert.ok(restored.value.rows >= 3);
  const dump = linesOf(await (await dumpOf("alpha")).text());
  assert.deepEqual(dump[0], { type: "header", version: 2, schema: [] });
  assert.deepEqual(dump.at(-1), { type: "end", rows: dump.length - 2 });
  assert.equal(
    (await restore("beta", dump.map((line) => JSON.stringify(line)).join("\n")))
      .status,
    409,
    "a site with data is never overwritten",
  );
  // A dump cut short is refused, and changes nothing.
  assert.equal(
    (await restore("gamma", `${JSON.stringify(dump[0])}\n`)).status,
    400,
  );
  assert.equal(
    rowsOf(linesOf(await (await dumpOf("gamma")).text()), "collections").length,
    0,
  );
  const moved = linesOf(await (await dumpOf("beta")).text());
  assert.deepEqual(rowsOf(moved, "documents"), rowsOf(dump, "documents"));
  assert.deepEqual(rowsOf(moved, "meta"), rowsOf(dump, "meta"));

  // The unique field came along, index and all.
  const duplicate = await operate("beta", "execute", {
    ...owner,
    site: "beta",
    path: ["posts", "two"],
    method: "PUT",
    body: { data: { title: "second", slug: "a" } },
  });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate));

  // Databases are files on disk: they outlive the process.
  await stop();
  await start();
  const again = await visit("beta/posts/one");
  assert.equal(again.status, 200);
  assert.equal((await again.json()).document.data.title, "first");
  console.log(
    `seoul: ${process.env.NARU_WORKERD_BIN ? "Naru's" : "npm's"} workerd serves the SDK, keeps sites and moves them.`,
  );
} finally {
  if (running && running.exitCode === null) await stop();
  await rm(objects, { recursive: true, force: true });
}
