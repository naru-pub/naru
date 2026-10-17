/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { callSiteObject } from "@/lib/edge/client";

// The breaker on statements the runtime stopped (edge/src/breaker.ts): a
// site's statement stopped 3 times within a minute is paused, refused before
// it reaches SQLite. Only with Naru's own workerd, which stops them: run with
// NARU_WORKERD_BIN set to it, as
//
//   NARU_WORKERD_BIN=<workerd-...-naru.N-darwin-arm64> LC_ALL=en_US.UTF-8 \
//     bash scripts/test-data-sdk.sh src/lib/site-data/__tests__/statement-breaker.test.ts
const integration =
  process.env.NARU_DATA_TEST === "1" && process.env.NARU_WORKERD_BIN
    ? describe
    : describe.skip;

const site = "breakersite";
const other = "breakerother";
const ownerId = "0190f5a0-0000-7000-8000-0000000000bc";
const put = (
  name: string,
  folder: string,
  file: string,
  source: string | null,
  publish = true,
) =>
  callSiteObject(name, "putFunctions", {
    site: name,
    folder,
    file,
    source,
    publish,
  });
const call = (kind: "query" | "mutation", fn: string, at = site) =>
  callSiteObject<{ result: unknown }>(at, "call", {
    ownerId,
    site: at,
    member: null,
    kind,
    file: "budget",
    name: fn,
    args: null,
  }).then((answer) => answer.result);

// As statement-budget.test.ts: 2.5 billion pairs the plan rule lets through.
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
export async function one(ctx) { await ctx.sql\`INSERT INTO tally (n) VALUES (1)\`; }
`;
const stopped = {
  status: 400,
  code: "INVALID_REQUEST",
  message: expect.stringMatching(/^This statement ran longer than 3 seconds/),
};
const paused = {
  status: 503,
  code: "UNAVAILABLE",
  message: expect.stringMatching(
    /^This statement of the site's code ran too long and was stopped 3 times within a minute, so it is paused for 5 more minutes\. The site's owner has been told\.$/,
  ),
  details: { reason: "statement_paused" },
  retryAfter: expect.any(Number),
};

type Trip = {
  id: string;
  kind: string;
  file: string;
  name: string;
  key: string;
  text: string | null;
  strikes: number;
  until: number;
  repeated: boolean;
  clearedAt: number | null;
  notifiedAt: number | null;
  pausedUntil: number | null;
};
const trips = () => callSiteObject<Trip[]>(site, "breakerTrips", {});
const unnotified = async () => {
  const response = await fetch(
    `${process.env.EDGE_WORKER_URL}/v1/breakers/unnotified`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.EDGE_WORKER_SECRET}` },
      body: "{}",
    },
  );
  return ((await response.json()) as { value: { sites: string[] } }).value
    .sites;
};
/** Trips are recorded after the call that paused them answers. */
const settled = async (count: number) => {
  for (let i = 0; i < 50; i++) {
    const list = await trips();
    if (list.length >= count) return list;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("No trip recorded.");
};

integration("a statement the runtime stops again and again", () => {
  test("a read stopped 3 times is paused and refused at once; the rest of the site and other sites go on", async () => {
    for (const name of [site, other]) {
      await callSiteObject(name, "erase", {});
      await put(name, "migrations", "0001_posts", ROWS, false);
      await put(name, "mutations", "budget", MUTATIONS, false);
      await put(name, "queries", "budget", QUERIES);
    }
    for (let strike = 0; strike < 3; strike++)
      await expect(call("query", "pairs")).rejects.toMatchObject(stopped);
    const started = Date.now();
    await expect(call("query", "pairs")).rejects.toMatchObject(paused);
    // Never reached SQLite: no 3-second step.
    expect(Date.now() - started).toBeLessThan(500);
    // The site's other statements, and other sites, are untouched.
    expect(await call("query", "posts")).toBe(50_000);
    expect(await call("query", "tally")).toBe(0);
    await expect(call("query", "pairs", other)).rejects.toMatchObject(stopped);

    const [trip] = await settled(1);
    expect(trip).toMatchObject({
      kind: "query",
      file: "budget",
      name: "pairs",
      text: PAIRS,
      strikes: 3,
      repeated: false,
      clearedAt: null,
      notifiedAt: null,
      pausedUntil: trip.until,
    });
    expect(trip.until - Date.now()).toBeGreaterThan(4 * 60_000);
    // The operators are told once: the site is listed until acknowledged.
    expect(await unnotified()).toContain(site);
    await callSiteObject(site, "ackBreakerTrips", { ids: [trip.id] });
    expect(await unnotified()).not.toContain(site);
    expect((await trips())[0].notifiedAt).toEqual(expect.any(Number));
  }, 120_000);

  test("the owner lets it run again (다시 허용)", async () => {
    const [trip] = await trips();
    await callSiteObject(site, "clearBreaker", { key: trip.key });
    expect((await trips())[0]).toMatchObject({
      clearedAt: expect.any(Number),
      pausedUntil: null,
    });
    // It runs, and is stopped, again.
    await expect(call("query", "pairs")).rejects.toMatchObject(stopped);
  }, 60_000);

  test("a write stopped 3 times, resetting the object each time, is paused by its statement", async () => {
    // The strike after the clear above is the read's; this is the write's.
    for (let strike = 0; strike < 3; strike++)
      await expect(call("mutation", "pairs")).rejects.toMatchObject(stopped);
    const started = Date.now();
    await expect(call("mutation", "pairs")).rejects.toMatchObject(paused);
    expect(Date.now() - started).toBeLessThan(500);
    // Its first write rolled back with the refusal; other writes go on.
    expect(await call("query", "tally")).toBe(0);
    await call("mutation", "one");
    expect(await call("query", "tally")).toBe(1);
    const [trip] = await settled(2);
    // What the object reported before the runtime reset it.
    expect(trip).toMatchObject({
      kind: "mutation",
      name: "pairs",
      text: `INSERT INTO tally (n) ${PAIRS}`,
      key: expect.stringMatching(/^mutation:budget:pairs:[A-Za-z0-9_-]+$/),
    });
    // A visitor meets the same pause at the data API, with Retry-After.
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
    expect(response.status).toBe(503);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(200);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAVAILABLE", details: { reason: "statement_paused" } },
    });
  }, 120_000);

  test("a new release clears every pause", async () => {
    await expect(call("mutation", "pairs")).rejects.toMatchObject(paused);
    await put(site, "queries", "budget", `${QUERIES}\n// again`);
    expect((await trips()).every((trip) => trip.clearedAt !== null)).toBe(true);
    await expect(call("mutation", "pairs")).rejects.toMatchObject(stopped);
    for (const name of [site, other]) await callSiteObject(name, "erase", {});
  }, 60_000);
});
