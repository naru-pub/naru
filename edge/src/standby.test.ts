import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { decide, FAIL_AFTER, HEARTBEAT_FRESH_MS, RETURN_AFTER, STALE_AFTER_MS } =
  await import("./standby");

const NOW = 1_800_000_000_000;
const base = {
  mode: "mini" as const,
  failures: 0,
  successes: 0,
  heartbeatAt: 0,
  heartbeat: {},
  sites: ["alice"],
  warned: false,
  changedAt: 0,
};
/** `times` checks in a row, each a minute apart, from `state`. */
function run(
  state: typeof base | ReturnType<typeof decide>["state"],
  healthy: boolean,
  times: number,
  standby?: Record<string, { collections: number; documents: number }>,
  /** The mini reports in each minute, as its sync job does. */
  reporting = false,
) {
  const results = [];
  for (let i = 0; i < times; i++) {
    const now = NOW + i * 60_000;
    if (reporting) state = { ...state, heartbeatAt: now };
    const result = decide(state, healthy, now, standby);
    results.push(result);
    state = result.state;
  }
  return results;
}

describe("the standby's health check", () => {
  test("is not armed until the mini has reported in once", () => {
    const results = run(base, false, FAIL_AFTER + 2);
    expect(results.every((r) => r.action === null)).toBe(true);
    expect(results.filter((r) => r.warning).length).toBe(1);
    expect(results.find((r) => r.warning)!.warning).toMatch(/not armed/);
  });

  test("fails over only after several silent minutes", () => {
    const results = run(
      { ...base, heartbeatAt: NOW - HEARTBEAT_FRESH_MS },
      false,
      FAIL_AFTER,
    );
    expect(results.slice(0, -1).every((r) => r.action === null)).toBe(true);
    expect(results.at(-1)!.action).toBe("failover");
    expect(results.at(-1)!.state.mode).toBe("standby");
  });

  test("a healthy minute starts the count again", () => {
    const [, , healthy] = run(base, false, 2);
    const again = decide(run(base, false, 2)[1].state, true, NOW);
    expect(again.state.failures).toBe(0);
    expect(healthy).toBeUndefined();
  });

  test("does not fail over while the mini reports in, and says so once", () => {
    const reporting = { ...base, heartbeatAt: NOW };
    const results = run(reporting, false, FAIL_AFTER + 2, undefined, true);
    expect(results.every((r) => r.action === null)).toBe(true);
    expect(results.filter((r) => r.warning).length).toBe(1);
    expect(results.at(-1)!.state.mode).toBe("mini");
  });

  test("a heartbeat older than a few minutes does not hold it back", () => {
    const stale = { ...base, heartbeatAt: NOW - HEARTBEAT_FRESH_MS };
    expect(run(stale, false, FAIL_AFTER).at(-1)!.action).toBe("failover");
  });

  const failedOver = {
    ...base,
    mode: "standby" as const,
    heartbeatAt: NOW,
    heartbeat: { alice: { collections: 2, documents: 10 } },
  };

  test("switches back after several healthy minutes when the mini holds what the standby does", () => {
    const results = run(
      failedOver,
      true,
      RETURN_AFTER,
      { alice: { collections: 2, documents: 9 } },
      true,
    );
    expect(results.slice(0, -1).every((r) => r.action === null)).toBe(true);
    expect(results.at(-1)!.action).toBe("return");
    expect(results.at(-1)!.state.mode).toBe("mini");
  });

  test("stays on the standby while the mini answers with data missing", () => {
    const results = run(
      failedOver,
      true,
      RETURN_AFTER + 2,
      { alice: { collections: 2, documents: 11 } },
      true,
    );
    expect(results.every((r) => r.action === null)).toBe(true);
    expect(results.filter((r) => r.warning).length).toBe(1);
    expect(results.find((r) => r.warning)!.warning).toMatch(/alice/);
  });

  test("stays on the standby until the mini reports in again", () => {
    const silent = { ...failedOver, heartbeatAt: NOW - HEARTBEAT_FRESH_MS };
    const results = run(silent, true, RETURN_AFTER);
    expect(results.at(-1)!.action).toBeNull();
    expect(results.at(-1)!.warning).toMatch(/not reported in/);
  });

  test("a failed probe while failed over starts the healthy count again", () => {
    const four = run(failedOver, true, RETURN_AFTER - 1).at(-1)!.state;
    expect(decide(four, false, NOW).state.successes).toBe(0);
  });

  test("warns once when the mini answers but stops reporting in, and once when it is back", () => {
    const quiet = { ...base, heartbeatAt: NOW - STALE_AFTER_MS };
    const results = run(quiet, true, 3);
    expect(results.every((r) => r.action === null)).toBe(true);
    expect(results.filter((r) => r.warning).length).toBe(1);
    expect(results[0].warning).toMatch(/standby-sync/);
    const back = decide(
      { ...results.at(-1)!.state, heartbeatAt: NOW },
      true,
      NOW + 60_000,
    );
    expect(back.note).toMatch(/reports in again/);
    expect(back.state.staleWarned).toBe(false);
  });
});
