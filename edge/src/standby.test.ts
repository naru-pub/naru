import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { decide, FAIL_AFTER } = await import("./standby");

type State = ReturnType<typeof decide>["state"];
/** One probe a minute, from `state`, with these results. */
function run(state: State, probes: boolean[]) {
  const alerts: (string | null)[] = [];
  for (const healthy of probes) {
    const result = decide(state, healthy);
    alerts.push(result.alert);
    state = result.state;
  }
  return { state, alerts };
}
const up: State = { failures: 0, down: false };

describe("the mini's health check", () => {
  test("says nothing while the mini answers", () => {
    expect(run(up, [true, true, true]).alerts).toEqual([null, null, null]);
  });

  test(`alerts once the mini has failed ${FAIL_AFTER} minutes in a row, and once only`, () => {
    const { state, alerts } = run(up, Array(FAIL_AFTER + 3).fill(false));
    expect(alerts.slice(0, FAIL_AFTER - 1)).toEqual(
      Array(FAIL_AFTER - 1).fill(null),
    );
    expect(alerts[FAIL_AFTER - 1]).toMatch(/has not answered/);
    expect(alerts.slice(FAIL_AFTER)).toEqual([null, null, null]);
    expect(state.down).toBe(true);
  });

  test("a failure that does not last is not reported", () => {
    const probes = [
      ...Array(FAIL_AFTER - 1).fill(false),
      true,
      ...Array(FAIL_AFTER - 1).fill(false),
    ];
    const { alerts } = run(up, probes);
    expect(alerts.every((alert) => alert === null)).toBe(true);
  });

  test("reports the mini back once, after it was reported down", () => {
    const down = run(up, Array(FAIL_AFTER).fill(false)).state;
    const { state, alerts } = run(down, [true, true]);
    expect(alerts[0]).toMatch(/answers again/);
    expect(alerts[1]).toBeNull();
    expect(state).toEqual(up);
  });
});
