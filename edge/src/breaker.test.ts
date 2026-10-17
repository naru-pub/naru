import { describe, expect, test } from "vitest";
import {
  admit,
  breakerKey,
  Breakers,
  breakers,
  LONG_PAUSE_MS,
  PAUSE_MS,
  pausedList,
  pausedRefusal,
  reportStop,
  settle,
  statementId,
  STRIKE_WINDOW_MS,
  takeStops,
  type Stop,
} from "./breaker";

// The clock is each call's `now`: a fake one, in ms.
const T = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const stop = (statement: string | null = "s1"): Stop => ({
  kind: "query",
  file: "posts",
  name: "list",
  statement,
  text: statement && `SELECT ${statement}`,
});

describe("a statement's breaker", () => {
  test("pauses on the third strike within a minute, for 5 minutes", () => {
    const b = new Breakers();
    expect(b.strike("alice", stop(), T)).toBeNull();
    expect(b.strike("alice", stop(), T + 20 * SECOND)).toBeNull();
    expect(b.paused("alice", T + 20 * SECOND)).toEqual([]);
    const trip = b.strike("alice", stop(), T + 40 * SECOND);
    expect(trip).toMatchObject({
      key: "query:posts:list:s1",
      at: T + 40 * SECOND,
      until: T + 40 * SECOND + PAUSE_MS,
      strikes: 3,
      repeated: false,
      text: "SELECT s1",
    });
    expect(b.paused("alice", T + MINUTE)).toEqual([
      { key: "query:posts:list:s1", until: trip!.until },
    ]);
    expect(b.unnotified.has("alice")).toBe(true);
    // Over when its time is.
    expect(b.paused("alice", trip!.until)).toEqual([]);
  });

  test("forgets strikes older than the window", () => {
    const b = new Breakers();
    b.strike("alice", stop(), T);
    b.strike("alice", stop(), T + 30 * SECOND);
    // The first is a minute old: two strikes in the window, not three.
    expect(b.strike("alice", stop(), T + STRIKE_WINDOW_MS)).toBeNull();
    expect(b.strike("alice", stop(), T + 80 * SECOND)).not.toBeNull();
  });

  test("ignores what is reported while it is paused", () => {
    const b = new Breakers();
    for (const s of [0, 1, 2]) b.strike("alice", stop(), T + s * SECOND);
    const until = b.paused("alice", T + 3 * SECOND)[0].until;
    for (const s of [3, 4, 5])
      expect(b.strike("alice", stop(), T + s * SECOND)).toBeNull();
    expect(b.paused("alice", T + 6 * SECOND)).toEqual([
      { key: "query:posts:list:s1", until },
    ]);
  });

  test("pauses for 30 minutes when it trips again within the hour", () => {
    const b = new Breakers();
    const trip = (at: number) => {
      b.strike("alice", stop(), at);
      b.strike("alice", stop(), at + SECOND);
      return b.strike("alice", stop(), at + 2 * SECOND)!;
    };
    const first = trip(T);
    expect(first.until - first.at).toBe(PAUSE_MS);
    const second = trip(first.until);
    expect(second).toMatchObject({ repeated: true });
    expect(second.until - second.at).toBe(LONG_PAUSE_MS);
    // An hour after the last pause, back to 5 minutes.
    const third = trip(second.at + 60 * MINUTE);
    expect(third).toMatchObject({ repeated: false });
    expect(third.until - third.at).toBe(PAUSE_MS);
  });

  test("is one statement's of one function of one site", () => {
    const b = new Breakers();
    for (const s of [0, 1, 2]) b.strike("alice", stop("s1"), T + s * SECOND);
    b.strike("alice", stop("s2"), T + 3 * SECOND);
    b.strike("bob", stop("s1"), T + 3 * SECOND);
    b.strike("alice", { ...stop("s1"), kind: "mutation" }, T + 3 * SECOND);
    expect(b.paused("alice", T + 4 * SECOND).map((p) => p.key)).toEqual([
      "query:posts:list:s1",
    ]);
    expect(b.paused("bob", T + 4 * SECOND)).toEqual([]);
  });

  test("is cleared, one or all, and forgets it was paused", () => {
    const b = new Breakers();
    const trip = (statement: string, at: number) => {
      for (const s of [0, 1, 2])
        b.strike("alice", stop(statement), at + s * SECOND);
    };
    trip("s1", T);
    trip("s2", T);
    b.clear("alice", "query:posts:list:s1");
    expect(b.paused("alice", T + 3 * SECOND).map((p) => p.key)).toEqual([
      "query:posts:list:s2",
    ]);
    // Paused again after its clear: 5 minutes, as a first pause.
    trip("s1", T + 10 * SECOND);
    const again = b
      .paused("alice", T + 13 * SECOND)
      .find((p) => p.key === "query:posts:list:s1")!;
    expect(again.until).toBe(T + 12 * SECOND + PAUSE_MS);
    b.clear("alice");
    expect(b.paused("alice", T + 13 * SECOND)).toEqual([]);
  });
});

describe("a statement's identity", () => {
  test("is its text, whitespace aside", () => {
    expect(statementId("SELECT *\n  FROM posts WHERE id = ?")).toBe(
      statementId(" SELECT * FROM posts  WHERE id = ? "),
    );
    expect(statementId("SELECT * FROM posts")).not.toBe(
      statementId("SELECT * FROM post"),
    );
    expect(breakerKey(stop(null))).toBe("query:posts:list:*");
  });

  test("is refused, while paused, with when to try again", () => {
    const error = pausedRefusal(T + 5 * MINUTE, T);
    expect(error).toMatchObject({
      status: 503,
      code: "UNAVAILABLE",
      details: { reason: "statement_paused" },
      retryAfter: 300,
    });
    expect(error.message).toBe(
      "This statement of the site's code ran too long and was stopped 3 times within a minute, so it is paused for 5 more minutes. The site's owner has been told.",
    );
    expect(pausedList([{ key: "k", until: 1 }, { key: 2 }, null])).toEqual([
      { key: "k", until: 1 },
    ]);
    expect(pausedList("nope")).toEqual([]);
  });
});

describe("the Worker's strikes", () => {
  const waits: Promise<unknown>[] = [];
  const recorded: unknown[] = [];
  const sites = {
    idFromName: () => ({}),
    get: () => ({
      recordBreakerTrip: async (input: unknown) => recorded.push(input),
    }),
  } as never;
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const call = { kind: "mutation" as const, file: "posts", name: "add" };

  test("count what the object reported, and the whole function when it reset unreported", async () => {
    const site = "carol";
    breakers.clear(site);
    reportStop(site, { ...call, statement: "w1", text: "INSERT 1" });
    expect(takeStops(site)).toHaveLength(1);
    expect(takeStops(site)).toEqual([]);
    const reset = new Error("interrupted: SQLITE_INTERRUPT");
    for (const s of [0, 1, 2]) {
      reportStop(site, { ...call, statement: "w1", text: "INSERT 1" });
      settle(sites, ctx, site, call, reset, T + s * SECOND);
    }
    await Promise.all(waits);
    expect(recorded).toEqual([
      {
        trip: expect.objectContaining({ key: "mutation:posts:add:w1" }),
        paused: [
          { key: "mutation:posts:add:w1", until: T + 2 * SECOND + PAUSE_MS },
        ],
      },
    ]);
    // The statement's pause is the object's to apply; the function runs.
    expect(admit(site, call, T + 3 * SECOND).refusal).toBeUndefined();
    // Nothing reported: the reset counts against the whole function.
    for (const s of [3, 4, 5])
      settle(sites, ctx, site, call, reset, T + s * SECOND);
    const admitted = admit(site, call, T + 6 * SECOND);
    expect(admitted.refusal).toMatchObject({ status: 503, retryAfter: 299 });
    expect(admitted.paused.map((p) => p.key).sort()).toEqual([
      "mutation:posts:add:*",
      "mutation:posts:add:w1",
    ]);
    // Any other failure is not a strike.
    breakers.clear(site);
    for (const s of [0, 1, 2, 3])
      settle(
        sites,
        ctx,
        site,
        call,
        new Error("Network connection lost."),
        T + s,
      );
    expect(breakers.paused(site, T + 4)).toEqual([]);
  });
});
