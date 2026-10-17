import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CORPUS, fill, SCHEMA, type Entry } from "./plan.corpus";
import { checkPlan, type PlanStep } from "./plan";

// The plan rule measured: every statement of plan.corpus.ts runs in workerd,
// the runtime site SQL runs in on the mini, against tables of N and then 4N
// rows, counting the rows SQLite read as a call's MAX_ROWS_READ counts them
// (the Durable Object cursor's rowsRead). Allowed statements read at most
// about 4x as many rows; refused ones (but those refused by design) more
// than 8x. The plans must match node:sqlite's, which sql.test.ts uses.

const N = 200;
const workerd = join(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/.bin/workerd",
);

/** A Durable Object that runs statements and says what each read. */
const WORKER = `
import { DurableObject } from "cloudflare:workers";
export class Db extends DurableObject {
  async fetch(request) {
    const { exec, statements } = await request.json();
    const sql = this.ctx.storage.sql;
    for (const text of exec) sql.exec(text);
    return Response.json(statements.map(({ sql: text, values }) => {
      const plan = sql.exec("EXPLAIN QUERY PLAN " + text, ...values).toArray();
      const cursor = sql.exec(text, ...values);
      cursor.toArray();
      return { plan, rowsRead: cursor.rowsRead };
    }));
  }
}
export default {
  fetch(request, env) {
    const name = new URL(request.url).pathname;
    return env.DB.get(env.DB.idFromName(name)).fetch(request);
  },
};
`;
const CONFIG = (port: number) => `
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    (name = "objects", disk = (path = "objects", writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const worker :Workerd.Worker = (
  compatibilityDate = "2026-10-01",
  modules = [(name = "worker", esModule = embed "worker.js")],
  bindings = [(name = "DB", durableObjectNamespace = "Db")],
  durableObjectNamespaces = [(className = "Db", uniqueKey = "plan-test", enableSql = true)],
  durableObjectStorage = (localDisk = "objects"),
);
`;

type Measured = { plan: PlanStep[]; rowsRead: number };
const measured = new Map<number, Measured[]>();
let running: ChildProcess | undefined;
let dir: string | undefined;

const schema = () => SCHEMA.split(";").filter((text) => text.trim());
const statements = CORPUS.map(({ sql, values }) => ({
  sql,
  values: values ?? [],
}));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "naru-plan-"));
  const port = await new Promise<number>((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
  await writeFile(join(dir, "worker.js"), WORKER);
  await writeFile(join(dir, "config.capnp"), CONFIG(port));
  await mkdir(join(dir, "objects"));
  running = spawn(workerd, ["serve", "config.capnp"], {
    cwd: dir,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const run = async (n: number) => {
    for (let tries = 0; ; tries++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/n${n}`, {
          method: "POST",
          body: JSON.stringify({ exec: [...schema(), ...fill(n)], statements }),
        });
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()) as Measured[];
      } catch (error) {
        if (tries > 100 || !String(error).includes("fetch failed")) throw error;
        await new Promise((done) => setTimeout(done, 100));
      }
    }
  };
  measured.set(N, await run(N));
  measured.set(4 * N, await run(4 * N));
}, 120_000);

afterAll(async () => {
  running?.kill();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const verdict = (plan: PlanStep[]) => {
  try {
    checkPlan(plan);
    return "allowed";
  } catch (error) {
    return (error as Error).message;
  }
};

describe("the plan rule, measured", () => {
  test("node:sqlite plans every statement as workerd does", () => {
    const db = new DatabaseSync(":memory:");
    for (const text of [...schema(), ...fill(N)]) db.exec(text);
    const details = (plan: PlanStep[]) => plan.map((step) => step.detail);
    for (const [index, { sql, values }] of statements.entries())
      expect(
        details(
          db
            .prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...(values as never[])) as PlanStep[],
        ),
        sql,
      ).toEqual(details(measured.get(N)![index].plan));
  });

  test.each(CORPUS.map((entry, index) => [entry.name, entry, index] as const))(
    "%s",
    (_, entry: Entry, index) => {
      const small = measured.get(N)![index];
      const large = measured.get(4 * N)![index];
      const growth = large.rowsRead / Math.max(small.rowsRead, 1);
      const seen = `${entry.sql}\n${small.plan.map((step) => step.detail).join("\n")}\nrows read ${small.rowsRead} -> ${large.rowsRead} (${growth.toFixed(2)}x)`;
      if (process.env.PLAN_REPORT)
        console.log(
          `${entry.growth}\t${small.rowsRead}\t${large.rowsRead}\t${growth.toFixed(2)}\t${entry.name}\t${verdict(small.plan)}`,
        );
      // The verdict, from the plans at both sizes.
      for (const { plan } of [small, large])
        if ("refused" in entry)
          expect(verdict(plan), seen).toMatch(entry.refused);
        else expect(verdict(plan), seen).toBe("allowed");
      if (entry.growth === "linear")
        expect(growth, seen).toBeLessThanOrEqual(4.5);
      if (entry.growth === "superlinear" || entry.growth === "gap")
        expect(growth, seen).toBeGreaterThanOrEqual(8);
    },
  );
});
