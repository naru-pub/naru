// Checks a workerd build for what sqlite-timeout.patch adds: with
// WORKERD_SQLITE_STATEMENT_TIMEOUT_MS set, a SQLite object's statement that
// runs past it is stopped. A read throws SQLITE_INTERRUPT where it ran, and
// the object lives on; a write rolls back and resets the object, whose
// caller's stub throws it, and the next request meets a fresh object with
// nothing of the write. A fast statement is untouched.
//
//   node seoul/workerd/selftest.mjs <workerd> [budget ms, default 500]
//
// build.mjs runs it on what it builds, and CI on the binary it downloads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [binary, budgetArg = "500"] = process.argv.slice(2);
if (!binary) {
  console.error("usage: node selftest.mjs <workerd> [budget ms]");
  process.exit(2);
}
const budget = Number(budgetArg);

// 50,000 rows joined with themselves on nothing an index serves: billions of
// steps, far past any budget, in one sqlite3_step.
const WORKER = `
import { DurableObject } from "cloudflare:workers";
const SLOW = "SELECT count(*) AS n FROM a a1, a a2 WHERE a1.x + a2.x = -1";
export class Obj extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS a (x INTEGER)");
    sql.exec("CREATE TABLE IF NOT EXISTS kv (v INTEGER)");
    if (sql.exec("SELECT count(*) AS n FROM a").one().n === 0)
      sql.exec("WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 50000) INSERT INTO a SELECT i FROM s");
    this.born = crypto.randomUUID();
  }
  async fetch(request) {
    const op = new URL(request.url).pathname.split("/").pop();
    const sql = this.ctx.storage.sql;
    const out = { born: this.born };
    const started = Date.now();
    try {
      if (op === "fast") out.result = sql.exec("SELECT count(*) AS n FROM kv").one().n;
      else if (op === "read") out.result = sql.exec(SLOW).one().n;
      else if (op === "write") {
        sql.exec("INSERT INTO kv VALUES (1)");
        sql.exec("INSERT INTO kv " + SLOW);
        out.result = "written";
      }
    } catch (error) {
      out.error = String(error?.message ?? error);
    }
    out.ms = Date.now() - started;
    return Response.json(out);
  }
}
export default {
  async fetch(request, env) {
    const stub = env.OBJ.get(env.OBJ.idFromName("one"));
    try {
      return await stub.fetch(request);
    } catch (error) {
      return Response.json({ stubError: String(error?.message ?? error) });
    }
  },
};
`;
const CONFIG = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    (name = "objects", disk = (path = "objects", writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  compatibilityDate = "2026-10-01",
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  bindings = [(name = "OBJ", durableObjectNamespace = "Obj")],
  durableObjectNamespaces = [(className = "Obj", uniqueKey = "selftest", enableSql = true)],
  durableObjectStorage = (localDisk = "objects"),
);
`;

const dir = await mkdtemp(join(tmpdir(), "naru-workerd-selftest-"));
const port = await new Promise((done) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});
let running;
try {
  await writeFile(join(dir, "worker.js"), WORKER);
  await writeFile(join(dir, "config.capnp"), CONFIG);
  await mkdir(join(dir, "objects"));
  running = spawn(
    resolve(binary),
    [
      "serve",
      "config.capnp",
      "--directory-path",
      `objects=${join(dir, "objects")}`,
      "--socket-addr",
      `http=127.0.0.1:${port}`,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        WORKERD_SQLITE_STATEMENT_TIMEOUT_MS: String(budget),
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  // A workerd without the patch never stops the slow statement.
  const get = async (op) =>
    (
      await fetch(`http://127.0.0.1:${port}/${op}`, {
        signal: AbortSignal.timeout(budget + 10_000),
      })
    ).json();
  for (let tries = 0; ; tries++) {
    try {
      await get("fast");
      break;
    } catch {
      if (tries > 100) throw new Error("workerd did not start.");
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  const first = await get("fast");
  assert.equal(first.result, 0, JSON.stringify(first));

  const read = await get("read");
  assert.match(read.error ?? "", /SQLITE_INTERRUPT/, JSON.stringify(read));
  assert.ok(
    read.ms >= budget && read.ms < budget + 2000,
    `read took ${read.ms} ms`,
  );
  assert.equal(read.born, first.born, "an interrupted read keeps the object");

  const write = await get("write");
  assert.match(
    write.stubError ?? "",
    /SQLITE_INTERRUPT/,
    JSON.stringify(write),
  );
  const after = await get("fast");
  assert.notEqual(
    after.born,
    first.born,
    "an interrupted write resets the object",
  );
  assert.equal(after.result, 0, "an interrupted write leaves nothing");
  console.log(
    `selftest: ${binary} stops a statement at ${budget} ms (read ${read.ms} ms, object kept; write reset the object).`,
  );
} finally {
  if (running && running.exitCode === null) {
    const exited = new Promise((done) => running.once("exit", done));
    running.kill();
    await exited;
  }
  await rm(dir, { recursive: true, force: true });
}
