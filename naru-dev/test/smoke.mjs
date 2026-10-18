// The package as a developer gets it, headless: the naru-dev command on a
// copy of test/fixture (pages, a query, a mutation, a route, a collection,
// a migration added while it runs, data kept across a restart), then the
// testing API (sign-ins as the owner and a member, reset, stop).
//
//   node test/smoke.mjs     here, or wherever @naru-pub/dev is installed
//                           (CI copies test/ beside an installed tarball)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const manifest = require.resolve("@naru-pub/dev/package.json");
const { version, bin } = JSON.parse(await readFile(manifest, "utf8"));
const command = join(dirname(manifest), bin["naru-dev"]);
const { startNaru } = await import("@naru-pub/dev/testing");

const scratch = await mkdtemp(join(tmpdir(), "naru-dev-smoke-"));
const site = join(scratch, "site");
await cp(join(here, "fixture"), site, { recursive: true });
const state = join(scratch, "state");
const timed = async (what, run) => {
  const started = Date.now();
  const value = await run();
  console.log(`ok ${what} (${Date.now() - started} ms)`);
  return value;
};

/** The command, until it prints its address. */
async function serve() {
  const child = spawn(
    process.execPath,
    [command, site, "--site", "smoke", "--port", "0", "--state", state],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const exited = new Promise((done) => child.once("exit", done));
  for (let tries = 0; ; tries++) {
    const origin = /naru-dev: smoke at (http:\/\/localhost:\d+)\//.exec(
      log,
    )?.[1];
    if (origin) return { child, origin, exited, log: () => log };
    if (child.exitCode !== null || tries > 600)
      throw new Error(`naru-dev did not start:\n${log}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}
const call = async (origin, kind, name, args, headers = {}) => {
  const response = await fetch(`${origin}/api/data/v1/smoke/${kind}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ args }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.result;
};
const until = async (what, check) => {
  for (let tries = 0; tries < 200; tries++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out waiting for ${what}.`);
};

let naru;
try {
  naru = await timed("the command starts", serve);
  assert.match(
    naru.log(),
    new RegExp(
      `@naru-pub/dev ${version.replaceAll(".", "\\.")} \\(naru-pub [0-9a-f]+(-dirty)?\\), SDK 1\\.0\\.0, 1\\.1\\.0`,
    ),
  );
  const { origin } = naru;

  await timed("pages, the SDK, a mutation, a query, a route", async () => {
    const page = await (await fetch(`${origin}/`)).text();
    assert.match(page, /<script type="importmap">/);
    const sdk = await fetch(`${origin}/sdk/1.1.0/naru.js`);
    assert.equal(sdk.status, 200);
    assert.match(await sdk.text(), new RegExp(origin));
    assert.equal(await call(origin, "_mutate", "notes:add", { text: "hi" }), 1);
    assert.deepEqual(await call(origin, "_query", "notes:list"), [
      { id: 1, text: "hi", author: null },
    ]);
    const route = await fetch(`${origin}/notes/1`);
    assert.equal(route.status, 200);
    assert.match(await route.text(), /<meta name="note" content="hi">/);
    assert.equal((await fetch(`${origin}/notes/9`)).status, 404);
  });

  await timed("_naru/collections.json, the types", async () => {
    const guestbook = await fetch(`${origin}/api/data/v1/smoke/guestbook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { name: "visitor" } }),
    });
    assert.equal(guestbook.status, 201, await guestbook.clone().text());
    const types = await readFile(
      join(site, "_naru/types/database.d.ts"),
      "utf8",
    );
    assert.match(types, /export interface Notes \{/);
  });

  await timed("a migration added while it runs", async () => {
    await writeFile(
      join(site, "_naru/migrations/0002_tags.sql"),
      "CREATE TABLE tags (name TEXT PRIMARY KEY);\n",
    );
    await until("the new table's types", async () =>
      /export interface Tags \{/.test(
        await readFile(join(site, "_naru/types/database.d.ts"), "utf8"),
      ),
    );
  });

  await timed("_naru/ rewritten many times at once", async () => {
    // As a rebuild of the site does while it runs: the same files written
    // over and over, so the watcher publishes them, and writes the same
    // bucket keys, again and again. Each save empties the file a moment
    // before writing it, as a slow writer does, which naru-dev mustn't
    // publish (an applied migration, emptied, is one changed).
    const migration = join(site, "_naru/migrations/0002_tags.sql");
    const tags = await readFile(migration, "utf8");
    const query = join(site, "_naru/queries/count.js");
    const save = async (path, text) => {
      const file = await open(path, "w");
      try {
        await new Promise((done) => setTimeout(done, 3));
        await file.writeFile(text);
      } finally {
        await file.close();
      }
    };
    for (let i = 0; i <= 40; i++) {
      await Promise.all([
        save(migration, tags),
        save(query, `export async function n(ctx) { return ${i}; }\n`),
      ]);
      await new Promise((done) => setTimeout(done, 5));
    }
    await until("the last version", async () => {
      const response = await fetch(
        `${origin}/api/data/v1/smoke/_query/count:n`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      return response.ok && (await response.json()).result === 40;
    });
    assert.doesNotMatch(
      naru.log(),
      /local bucket answered|cannot be changed|changed while publishing/,
    );
  });

  await timed("data kept across a restart", async () => {
    naru.child.kill("SIGTERM");
    assert.equal(await naru.exited, 0);
    naru = await serve();
    assert.deepEqual(await call(naru.origin, "_query", "notes:list"), [
      { id: 1, text: "hi", author: null },
    ]);
    naru.child.kill("SIGTERM");
    assert.equal(await naru.exited, 0);
  });

  await timed("the testing API", async () => {
    const local = await startNaru({ site, name: "smoke", quiet: true });
    try {
      assert.match(local.origin, /^http:\/\/localhost:\d+$/);
      assert.equal(local.url("/notes/1"), `${local.origin}/notes/1`);
      // A state of its own, apart from the command's.
      assert.deepEqual(await call(local.origin, "_query", "notes:list"), []);
      const owner = await local.signIn(null, "owner");
      await call(
        local.origin,
        "_mutate",
        "notes:add",
        { text: "o" },
        owner.headers,
      );
      const alice = await local.signIn(null, "alice");
      assert.match(alice.memberId, /^[0-9a-f-]{36}$/);
      await call(
        local.origin,
        "_mutate",
        "notes:add",
        { text: "a" },
        alice.headers,
      );
      assert.deepEqual(
        (await call(local.origin, "_query", "notes:list")).map(
          (row) => row.author,
        ),
        ["owner", alice.memberId],
      );
      const banned = await local.signIn(null, "mallory", { status: "banned" });
      const refused = await fetch(
        `${local.origin}/api/data/v1/smoke/_query/notes:list`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...banned.headers },
          body: "{}",
        },
      );
      assert.equal(refused.status, 403);
      // A browser target gets an init script that keeps the session where
      // the SDK looks for it.
      const scripts = [];
      await local.signIn(
        { addInitScript: async (s) => scripts.push(s) },
        "owner",
      );
      assert.match(scripts[0], /naru:owner:/);
      await local.reset();
      assert.deepEqual(await call(local.origin, "_query", "notes:list"), []);
      assert.match(local.log, /owner signed in|published _naru\//);
    } finally {
      await local.stop();
    }
    assert.equal(existsSync(local.state), false);
    await assert.rejects(fetch(local.origin));
  });
  console.log("naru-dev smoke test passed");
} finally {
  naru?.child.kill("SIGTERM");
  await rm(scratch, { recursive: true, force: true });
}
