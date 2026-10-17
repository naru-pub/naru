import { DurableObject } from "cloudflare:workers";

// The mini's watcher on Cloudflare. Site databases live only on the mini
// (seoul.ts, sdk.naru.pub, which is DNS-only, straight to it); this one
// object does two things for the Worker here:
//
// - It forwards the Worker's calls to the mini (`forward`): a route's page is
//   rendered there (index.ts `renderRoute`).
// - It is the mini's health check, called each minute by the Worker's cron.
//   It probes two hosts at once, each counted on its own (TARGETS):
//   origin.sdk.naru.pub/healthz/deep, workerd and the site databases, and
//   naru.pub/api/health (CONTROL_PLANE_HEALTH_URL), the control plane, which
//   is also straight to the mini (Caddy, the nginx gateway, then Next). Each
//   posts to Discord, naming its host, once it has failed FAIL_AFTER minutes
//   in a row, and again when it answers. It only alerts: nothing fails over.
//
// The class keeps its name, and its binding, from when it also served a
// read-only standby of every site: renaming a Durable Object class deletes
// its objects.

export interface StandbyEnv {
  /** The mini's own name, origin.sdk.naru.pub: probed and forwarded to. */
  SDK_ORIGIN_HOST?: string;
  /**
   * The control plane's health endpoint, https://naru.pub/api/health, which
   * answers {"status":"ok"}. Without it, the control plane is not probed.
   */
  CONTROL_PLANE_HEALTH_URL?: string;
  DISCORD_WEBHOOK?: string;
}

/** One host's health, as the check keeps it. */
export type Health = {
  /** Failed probes in a row. */
  failures: number;
  /** The host was reported down, and has not been reported back since. */
  down: boolean;
};

/** What the health check watches, and how it names each in its alerts. */
export const TARGETS = {
  sdk: {
    down: (minutes: number) =>
      `🚨 sdk.naru.pub: the mini has not answered for ${minutes} minutes. Sites' data is unavailable until it is back.`,
    back: "✅ sdk.naru.pub: the mini answers again.",
  },
  controlPlane: {
    down: (minutes: number) =>
      `🚨 naru.pub: the control plane has not answered for ${minutes} minutes. Sign-in, the control panel and uploads are unavailable until it is back.`,
    back: "✅ naru.pub answers again.",
  },
} as const;
export type Target = keyof typeof TARGETS;

/** Every host's health, as stored under "state". */
export type Stored = {
  [target in Target]: Health;
} & {
  /** The last minute the health check ran, and what each probe found. */
  checkedAt?: number;
  healthy?: { [target in Target]?: boolean | null };
};

export const FAIL_AFTER = 3;
const PROBE_TIMEOUT_MS = 8_000;

const INITIAL: Health = { failures: 0, down: false };

const healthOf = (stored: unknown): Health => {
  const value = (stored ?? {}) as Partial<Health>;
  return {
    failures:
      typeof value.failures === "number" ? value.failures : INITIAL.failures,
    down: typeof value.down === "boolean" ? value.down : INITIAL.down,
  };
};

/**
 * What was stored, read as each host's health. Before the control plane was
 * probed, the state was the mini's alone, `{ failures, down, ... }` at the
 * top: that is sdk's.
 */
export function loadHealth(stored: unknown): Record<Target, Health> {
  const value = (stored ?? {}) as Record<string, unknown>;
  const single = "failures" in value || "down" in value;
  return {
    sdk: healthOf(single ? value : value.sdk),
    controlPlane: healthOf(value.controlPlane),
  };
}

/**
 * What the health check decides for one host, given its probe's result:
 * pure, so tested.
 */
export function decide(
  state: Health,
  healthy: boolean,
  target: Target = "sdk",
): { state: Health; alert: string | null } {
  if (healthy)
    return {
      state: { failures: 0, down: false },
      alert: state.down ? TARGETS[target].back : null,
    };
  const failures = state.failures + 1;
  if (failures < FAIL_AFTER || state.down)
    return { state: { ...state, failures }, alert: null };
  return {
    state: { failures, down: true },
    alert: TARGETS[target].down(failures),
  };
}

/**
 * Whether naru.pub/api/health answered as the control plane does: 200 with
 * {"status":"ok"} as JSON. A gateway's error page, a 502, a redirect or any
 * other page counts as down.
 */
export function controlPlaneHealthy(
  status: number,
  contentType: string | null,
  body: string,
) {
  if (status !== 200 || !contentType?.startsWith("application/json"))
    return false;
  try {
    return (JSON.parse(body) as { status?: unknown })?.status === "ok";
  } catch {
    return false;
  }
}

export class Standby extends DurableObject<StandbyEnv> {
  /**
   * The cron's minute: probe both hosts at once and alert on what `decide`
   * says for each. A host with no probe configured keeps its state.
   */
  async check() {
    const [sdk, controlPlane] = await Promise.all([
      this.probeSdk(),
      this.probeControlPlane(),
    ]);
    const healthy: Record<Target, boolean | null> = { sdk, controlPlane };
    const state = loadHealth(await this.ctx.storage.get("state"));
    const alerts: string[] = [];
    for (const target of Object.keys(TARGETS) as Target[]) {
      const result = healthy[target];
      if (result === null) continue;
      const decided = decide(state[target], result, target);
      state[target] = decided.state;
      if (decided.alert) alerts.push(decided.alert);
    }
    await Promise.all(alerts.map((alert) => this.notify(alert)));
    await this.ctx.storage.put("state", {
      ...state,
      checkedAt: Date.now(),
      healthy,
    } satisfies Stored);
    return { healthy, alerts };
  }

  /**
   * A request for the mini, sent on to origin.sdk.naru.pub. From this
   * object: the Worker's own data center (Los Angeles, for Korea) could not
   * connect to the mini's home line in the 2026-10-15 drill, while this
   * object's probes always did.
   */
  async forward(request: Request): Promise<Response> {
    const url = new URL(request.url);
    url.hostname = this.env.SDK_ORIGIN_HOST!;
    return fetch(new Request(url, request));
  }

  /** workerd answers and a site database opens; null when not set up. */
  private async probeSdk() {
    if (!this.env.SDK_ORIGIN_HOST) return null;
    try {
      const response = await fetch(
        `https://${this.env.SDK_ORIGIN_HOST}/healthz/deep`,
        { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      );
      return response.ok && (await response.text()) === "ok";
    } catch {
      return false;
    }
  }

  /** The control plane's own answer, reached through the gateway. */
  private async probeControlPlane() {
    const url = this.env.CONTROL_PLANE_HEALTH_URL;
    if (!url) return null;
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return controlPlaneHealthy(
        response.status,
        response.headers.get("content-type"),
        await response.text(),
      );
    } catch {
      return false;
    }
  }

  private async notify(content: string) {
    if (!this.env.DISCORD_WEBHOOK) return;
    await fetch(this.env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }).catch((error) => console.error("Posting to Discord failed", error));
  }
}
