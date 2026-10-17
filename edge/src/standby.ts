import { DurableObject } from "cloudflare:workers";

// The mini's watcher on Cloudflare. Site databases live only on the mini
// (seoul.ts, sdk.naru.pub, which is DNS-only, straight to it); this one
// object does two things for the Worker here:
//
// - It forwards the Worker's calls to the mini (`forward`): a route's page is
//   rendered there (index.ts `renderRoute`).
// - It is the mini's health check, called each minute by the Worker's cron:
//   it probes origin.sdk.naru.pub/healthz/deep, posts to Discord once the
//   mini has failed FAIL_AFTER minutes in a row, and again when it answers.
//   It only alerts: nothing fails over.
//
// The class keeps its name, and its binding, from when it also served a
// read-only standby of every site: renaming a Durable Object class deletes
// its objects.

export interface StandbyEnv {
  /** The mini's own name, origin.sdk.naru.pub: probed and forwarded to. */
  SDK_ORIGIN_HOST?: string;
  DISCORD_WEBHOOK?: string;
}

export type Health = {
  /** Failed probes in a row. */
  failures: number;
  /** The mini was reported down, and has not been reported back since. */
  down: boolean;
  /** The last minute the health check ran, and what it found. */
  checkedAt?: number;
  healthy?: boolean;
};

export const FAIL_AFTER = 3;
const PROBE_TIMEOUT_MS = 8_000;

const INITIAL: Health = { failures: 0, down: false };

/** What the health check decides, given a probe's result: pure, so tested. */
export function decide(
  state: Health,
  healthy: boolean,
): { state: Health; alert: string | null } {
  if (healthy)
    return {
      state: { ...state, failures: 0, down: false },
      alert: state.down ? "✅ sdk.naru.pub: the mini answers again." : null,
    };
  const failures = state.failures + 1;
  if (failures < FAIL_AFTER || state.down)
    return { state: { ...state, failures }, alert: null };
  return {
    state: { ...state, failures, down: true },
    alert: `🚨 sdk.naru.pub: the mini has not answered for ${failures} minutes. Sites' data is unavailable until it is back.`,
  };
}

export class Standby extends DurableObject<StandbyEnv> {
  private async state(): Promise<Health> {
    // What an older release stored here has more fields: only these stay.
    const stored = await this.ctx.storage.get<Partial<Health>>("state");
    return {
      failures: stored?.failures ?? INITIAL.failures,
      down: stored?.down ?? INITIAL.down,
    };
  }

  /** The cron's minute: probe the mini and alert on what `decide` says. */
  async check() {
    const healthy = await this.probe();
    const { state, alert } = decide(await this.state(), healthy);
    if (alert) await this.notify(alert);
    await this.ctx.storage.put("state", {
      ...state,
      checkedAt: Date.now(),
      healthy,
    } satisfies Health);
    return { healthy, alert };
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

  private async probe() {
    if (!this.env.SDK_ORIGIN_HOST) return true;
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

  private async notify(content: string) {
    if (!this.env.DISCORD_WEBHOOK) return;
    await fetch(this.env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }).catch((error) => console.error("Posting to Discord failed", error));
  }
}
