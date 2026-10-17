import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
const { controlPlaneHealthy, decide, FAIL_AFTER, loadHealth, Standby } =
  await import("./standby");

type State = ReturnType<typeof decide>["state"];
type Target = Parameters<typeof decide>[2];
/** One probe a minute, from `state`, with these results. */
function run(state: State, probes: boolean[], target: Target = "sdk") {
  const alerts: (string | null)[] = [];
  for (const healthy of probes) {
    const result = decide(state, healthy, target);
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

describe("naru.pub's health check", () => {
  test("names naru.pub when it is down and when it is back", () => {
    const { state, alerts } = run(
      up,
      Array(FAIL_AFTER).fill(false),
      "controlPlane",
    );
    expect(alerts.slice(0, -1).every((alert) => alert === null)).toBe(true);
    expect(alerts.at(-1)).toBe(
      `🚨 naru.pub: the control plane has not answered for ${FAIL_AFTER} minutes. Sign-in, the control panel and uploads are unavailable until it is back.`,
    );
    expect(run(state, [true], "controlPlane").alerts).toEqual([
      "✅ naru.pub answers again.",
    ]);
  });

  test("is counted apart from the mini's, so neither hides the other", () => {
    // The mini's workerd is down for good; naru.pub only blips, then fails.
    let state = loadHealth(undefined);
    const alerts: string[] = [];
    const minutes: [boolean, boolean][] = [
      [false, false],
      [false, true],
      [false, false],
      [false, false],
      [false, false],
      [true, false],
    ];
    for (const [sdk, controlPlane] of minutes) {
      const a = decide(state.sdk, sdk, "sdk");
      const b = decide(state.controlPlane, controlPlane, "controlPlane");
      state = { sdk: a.state, controlPlane: b.state };
      alerts.push(...[a.alert, b.alert].filter((x): x is string => !!x));
    }
    expect(alerts).toEqual([
      expect.stringMatching(
        /^🚨 sdk\.naru\.pub: the mini has not answered for 3/,
      ),
      expect.stringMatching(
        /^🚨 naru\.pub: the control plane has not answered for 3/,
      ),
      "✅ sdk.naru.pub: the mini answers again.",
    ]);
    expect(state.controlPlane).toEqual({ failures: 4, down: true });
  });

  test("counts only the control plane's own answer as up", () => {
    const json = "application/json";
    expect(controlPlaneHealthy(200, json, '{"status":"ok"}')).toBe(true);
    expect(
      controlPlaneHealthy(
        200,
        "application/json; charset=utf-8",
        '{"status":"ok"}',
      ),
    ).toBe(true);
    // The database is away, or the gateway answers for a missing upstream.
    expect(controlPlaneHealthy(503, json, '{"status":"unavailable"}')).toBe(
      false,
    );
    expect(controlPlaneHealthy(502, "text/html", "Bad Gateway")).toBe(false);
    expect(controlPlaneHealthy(504, null, "")).toBe(false);
    // A gateway's own page, or a redirect, is not the control plane.
    expect(controlPlaneHealthy(200, "text/html", "<h1>Maintenance</h1>")).toBe(
      false,
    );
    expect(controlPlaneHealthy(302, null, "")).toBe(false);
    expect(controlPlaneHealthy(200, json, '{"status":"unavailable"}')).toBe(
      false,
    );
    expect(controlPlaneHealthy(200, json, "not json")).toBe(false);
    expect(controlPlaneHealthy(200, json, "null")).toBe(false);
  });
});

describe("the stored state", () => {
  test("an older release's, the mini's alone, loads as sdk's", () => {
    expect(
      loadHealth({ failures: 2, down: false, checkedAt: 1, healthy: false }),
    ).toEqual({
      sdk: { failures: 2, down: false },
      controlPlane: { failures: 0, down: false },
    });
    expect(loadHealth({ failures: 5, down: true })).toEqual({
      sdk: { failures: 5, down: true },
      controlPlane: { failures: 0, down: false },
    });
  });

  test("this release's keeps each host's, and nothing is a fresh start", () => {
    const stored = {
      sdk: { failures: 0, down: false },
      controlPlane: { failures: 4, down: true },
      checkedAt: 1,
      healthy: { sdk: true, controlPlane: false },
    };
    expect(loadHealth(stored)).toEqual({
      sdk: stored.sdk,
      controlPlane: stored.controlPlane,
    });
    expect(loadHealth(undefined)).toEqual({
      sdk: { failures: 0, down: false },
      controlPlane: { failures: 0, down: false },
    });
  });
});

describe("the cron's minute", () => {
  const object = (env: Record<string, string>, stored?: unknown) => {
    const storage = new Map<string, unknown>([["state", stored]]);
    const standby = new Standby(
      {
        storage: {
          get: async (key: string) => storage.get(key),
          put: async (key: string, value: unknown) =>
            void storage.set(key, value),
        },
      } as never,
      env as never,
    );
    return { standby, storage };
  };

  test("probes both hosts at once and alerts for each on its own", async () => {
    const posted: string[] = [];
    let inFlight = 0;
    let most = 0;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input === "https://discord.example/hook") {
        posted.push(JSON.parse(init!.body as string).content);
        return new Response(null, { status: 204 });
      }
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((done) => setTimeout(done, 5));
      inFlight--;
      if (input === "https://origin.sdk.naru.pub/healthz/deep")
        return new Response("ok");
      // nginx with no control plane behind it.
      return new Response("Bad Gateway", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      });
    });
    try {
      const { standby, storage } = object(
        {
          SDK_ORIGIN_HOST: "origin.sdk.naru.pub",
          CONTROL_PLANE_HEALTH_URL: "https://naru.pub/api/health",
          DISCORD_WEBHOOK: "https://discord.example/hook",
        },
        // As an older release left it: the mini down, and reported.
        { failures: 4, down: true, checkedAt: 1, healthy: false },
      );
      await standby.check();
      await standby.check();
      const last = await standby.check();
      expect(most).toBe(2);
      expect(last.healthy).toEqual({ sdk: true, controlPlane: false });
      expect(posted).toEqual([
        "✅ sdk.naru.pub: the mini answers again.",
        expect.stringMatching(
          /^🚨 naru\.pub: the control plane has not answered for 3 minutes/,
        ),
      ]);
      expect(storage.get("state")).toMatchObject({
        sdk: { failures: 0, down: false },
        controlPlane: { failures: 3, down: true },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("probes nothing that is not set up", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const { standby } = object({});
      expect(await standby.check()).toEqual({
        healthy: { sdk: null, controlPlane: null },
        alerts: [],
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
