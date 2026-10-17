/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { callSiteObject } from "@/lib/edge/client";

// The step budget of Naru's own workerd (edge/seoul/workerd/), which the
// mini runs: a site's statement that the plan rule lets through and that
// still runs past 3 seconds is stopped. Only with that workerd: run with
// NARU_WORKERD_BIN set to it (scripts/with-edge-worker.sh), as
//
//   NARU_WORKERD_BIN=<workerd-...-naru.N-darwin-arm64> \
//     bash scripts/test-data-sdk.sh src/lib/site-data/__tests__/statement-budget.test.ts
const integration =
  process.env.NARU_DATA_TEST === "1" && process.env.NARU_WORKERD_BIN
    ? describe
    : describe.skip;

const site = "budgetsite";
const ownerId = "0190f5a0-0000-7000-8000-0000000000bb";
const put = (
  folder: string,
  file: string,
  source: string | null,
  publish = true,
) =>
  callSiteObject(site, "putFunctions", { site, folder, file, source, publish });
const call = (kind: "query" | "mutation", name: string) =>
  callSiteObject<{ result: unknown }>(site, "call", {
    ownerId,
    site,
    member: null,
    kind,
    file: "budget",
    name,
    args: null,
  }).then((answer) => answer.result);

// 50,000 posts on one board: each one's board matches every post by the
// index, which the plan rule counts as bounded (plan.ts, "the known gap").
// The pairs are 2.5 billion.
const PAIRS =
  "SELECT count(*) AS n FROM posts p1 JOIN posts p2 ON p2.board = p1.board";
const ROWS = `CREATE TABLE posts (id INTEGER PRIMARY KEY, board TEXT NOT NULL);
CREATE INDEX posts_board ON posts (board);
CREATE TABLE tally (n INTEGER);
INSERT INTO posts (board)
  SELECT 'free' FROM json_each('[' || substr(replace(hex(zeroblob(50000)), '00', '0,'), 1, 99999) || ']');`;
const QUERIES = `
export async function tally(ctx) { return (await ctx.sql\`SELECT count(*) AS n FROM tally\`).rows[0].n; }
export async function posts(ctx) { return (await ctx.sql\`SELECT count(*) AS n FROM posts\`).rows[0].n; }
export async function pairs(ctx) { return (await ctx.sql\`${PAIRS}\`).rows[0].n; }
`;
const MUTATIONS = `
export async function pairs(ctx) {
  await ctx.sql\`INSERT INTO tally (n) VALUES (1)\`;
  await ctx.sql\`INSERT INTO tally (n) ${PAIRS}\`;
}
`;
const stopped = {
  status: 400,
  code: "INVALID_REQUEST",
  message:
    "This statement ran longer than 3 seconds and was stopped; give it an index or read less.",
};

integration("a statement past the step budget", () => {
  test("a read is stopped and the call refused, and the object goes on", async () => {
    await callSiteObject(site, "erase", {});
    await put("migrations", "0001_posts", ROWS, false);
    await put("mutations", "budget", MUTATIONS, false);
    await put("queries", "budget", QUERIES);
    expect(await call("query", "posts")).toBe(50_000);
    const started = Date.now();
    await expect(call("query", "pairs")).rejects.toMatchObject(stopped);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(await call("query", "tally")).toBe(0);
  }, 60_000);

  test("a write is stopped, rolls back and resets the object, whose caller says why", async () => {
    await expect(call("mutation", "pairs")).rejects.toMatchObject(stopped);
    // The object came back, without the call's first write.
    expect(await call("query", "tally")).toBe(0);
    expect(await call("query", "posts")).toBe(50_000);
    // A visitor's call at the edge, as browsers reach it.
    await callSiteObject(site, "configure", {
      ownerId,
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
    });
    const response = await fetch(
      `${process.env.EDGE_WORKER_URL}/api/data/v1/${site}/_mutate/budget:pairs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: null }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: stopped.code, message: stopped.message },
    });
    expect(await call("query", "tally")).toBe(0);
  }, 60_000);

  test("a migration is stopped and refuses its release, which changes nothing", async () => {
    for (const sql of [
      // Held to its plan, which lets it through.
      `INSERT INTO tally (n) ${PAIRS};`,
      // A schema statement, which no plan holds.
      `CREATE TABLE pairs AS ${PAIRS};`,
    ]) {
      const started = Date.now();
      await expect(put("migrations", "0002_pairs", sql)).rejects.toMatchObject({
        status: 422,
        code: "INVALID_REQUEST",
        message: expect.stringMatching(
          /^A migration ran longer than 3 seconds and was stopped, so the release changed nothing/,
        ),
        details: { reason: "migration_failed" },
      });
      expect(Date.now() - started).toBeLessThan(8000);
      await put("migrations", "0002_pairs", null, false);
    }
    // The release before still serves, with only its own migration applied.
    await put("queries", "budget", QUERIES);
    expect(await call("query", "tally")).toBe(0);
    const tables = await callSiteObject<{ name: string }[]>(
      site,
      "siteTables",
      {},
    );
    expect(tables.map((table) => table.name).sort()).toEqual([
      "posts",
      "tally",
    ]);
    await callSiteObject(site, "erase", {});
  }, 120_000);
});
