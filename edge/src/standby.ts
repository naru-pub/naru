import { DurableObject } from "cloudflare:workers";
import type { SiteData } from "./site";
import type { Outcome } from "./types";

// The standby on Cloudflare for the Data SDK, which lives on the mini
// (seoul.ts). sdk.naru.pub is an A record for the mini; turning on
// Cloudflare's proxy for it sends its traffic here instead. While the mini is
// up, what still arrives here (resolvers holding the record past its TTL) is
// forwarded to origin.sdk.naru.pub, the mini's own name, which never moves.
// While it is away, this serves visitors read-only from the copies the
// control plane keeps (control-plane/src/lib/edge/standby.ts).
//
// The health check is this object, called each minute by the Worker's cron:
//
// - It probes origin.sdk.naru.pub. After FAIL_AFTER failed minutes it fails
//   over, unless the mini reported in within HEARTBEAT_FRESH_MS: then the
//   mini is up and only these probes cannot reach it (Korea's routes abroad
//   are the weak link), and failing over would make its users read-only for
//   nothing.
// - Failed over, after RETURN_AFTER healthy minutes it switches back, once
//   the mini reports in with at least the data the standby holds. A mini
//   that answers with its data missing is a restore, not a switch.
//
// Each change of mode is posted to Discord.

export interface StandbyEnv {
  SITES: DurableObjectNamespace<SiteData>;
  PLATFORM_DOMAIN: string;
  /** The mini's own name, origin.sdk.naru.pub: probed and forwarded to. */
  SDK_ORIGIN_HOST?: string;
  /** Edits naru.pub's DNS: the proxy on sdk.naru.pub. */
  CLOUDFLARE_DNS_TOKEN?: string;
  DISCORD_WEBHOOK?: string;
}

export type Mode = "mini" | "standby";
type Counts = Record<string, { collections: number; documents: number }>;
type State = {
  mode: Mode;
  failures: number;
  successes: number;
  heartbeatAt: number;
  heartbeat: Counts;
  /** Sites whose copies the standby holds. */
  sites: string[];
  /** A warning already posted for the present spell, so it is not repeated. */
  warned: boolean;
  changedAt: number;
  /** A warning posted that the mini stopped reporting in while it answers. */
  staleWarned?: boolean;
  /** The last minute the health check ran, and what it found. */
  checkedAt?: number;
  healthy?: boolean;
};

export const FAIL_AFTER = 3;
export const RETURN_AFTER = 5;
export const HEARTBEAT_FRESH_MS = 3 * 60_000;
/**
 * The mini answers but has not reported in for this long: the copies here
 * are going stale, so the standby would serve old data if it had to.
 */
export const STALE_AFTER_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;

const INITIAL: State = {
  mode: "mini",
  failures: 0,
  successes: 0,
  heartbeatAt: 0,
  heartbeat: {},
  sites: [],
  warned: false,
  changedAt: 0,
};

/** What the health check decides, given a probe's result: pure, so tested. */
export function decide(
  state: State,
  healthy: boolean,
  now: number,
  standbyCounts?: Counts,
): {
  state: State;
  action: "failover" | "return" | null;
  warning: string | null;
  /** Good news to post, such as copies being kept up to date again. */
  note?: string | null;
} {
  const next = { ...state };
  const heartbeatFresh = now - state.heartbeatAt < HEARTBEAT_FRESH_MS;
  if (state.mode === "mini") {
    if (healthy) {
      next.failures = 0;
      next.warned = false;
      const stale =
        state.heartbeatAt > 0 && now - state.heartbeatAt >= STALE_AFTER_MS;
      if (stale && !state.staleWarned) {
        next.staleWarned = true;
        return {
          state: next,
          action: null,
          warning: `sdk.naru.pub: the standby's copies are not being kept up to date: the mini answers but has not reported in for ${Math.round((now - state.heartbeatAt) / 60_000)} minutes. Check naru's standby-sync job.`,
        };
      }
      if (!stale && state.staleWarned) {
        next.staleWarned = false;
        return {
          state: next,
          action: null,
          warning: null,
          note: "✅ sdk.naru.pub: the mini reports in again; the standby's copies are kept up to date.",
        };
      }
      return { state: next, action: null, warning: null };
    }
    next.failures++;
    if (next.failures < FAIL_AFTER)
      return { state: next, action: null, warning: null };
    // Until the mini has reported in once, the check is not armed: what it
    // probes may simply not be deployed yet.
    if (heartbeatFresh || state.heartbeatAt === 0) {
      const warning = next.warned
        ? null
        : state.heartbeatAt === 0
          ? `sdk.naru.pub: Cloudflare cannot reach the mini for ${next.failures} minutes, and it has never reported in, so the standby is not armed.`
          : `sdk.naru.pub: Cloudflare cannot reach the mini for ${next.failures} minutes, but the mini reports in, so it is not failing over.`;
      next.warned = true;
      return { state: next, action: null, warning };
    }
    next.mode = "standby";
    next.successes = 0;
    next.warned = false;
    next.changedAt = now;
    return { state: next, action: "failover", warning: null };
  }
  next.successes = healthy ? next.successes + 1 : 0;
  if (next.successes < RETURN_AFTER)
    return { state: next, action: null, warning: null };
  const missing = heartbeatFresh
    ? Object.entries(standbyCounts ?? {}).filter(([site, held]) => {
        const there = state.heartbeat[site];
        return (
          !there ||
          there.collections < held.collections ||
          there.documents < held.documents
        );
      })
    : null;
  if (missing === null || missing.length) {
    const warning = next.warned
      ? null
      : missing === null
        ? "sdk.naru.pub: the mini answers again but has not reported in; staying on the standby."
        : `sdk.naru.pub: the mini answers again but holds less than the standby for ${missing
            .map(([site]) => site)
            .join(", ")}; staying on the standby. Check its data by hand.`;
    next.warned = true;
    return { state: next, action: null, warning };
  }
  next.mode = "mini";
  next.failures = 0;
  next.warned = false;
  next.changedAt = now;
  return { state: next, action: "return", warning: null };
}

export class Standby extends DurableObject<StandbyEnv> {
  private async state(): Promise<State> {
    return {
      ...INITIAL,
      ...((await this.ctx.storage.get<State>("state")) ?? {}),
    };
  }
  private save(state: State) {
    return this.ctx.storage.put("state", state);
  }

  async mode(): Promise<Mode> {
    return (await this.state()).mode;
  }

  async status() {
    return this.state();
  }

  /** The mini reports in, with each site's counts there. */
  async heartbeat(input: { sites?: Counts }) {
    const state = await this.state();
    state.heartbeatAt = Date.now();
    state.heartbeat = input?.sites ?? {};
    await this.save(state);
    return null;
  }

  /** A site whose copy the standby now holds. */
  async held(site: string) {
    const state = await this.state();
    if (!state.sites.includes(site)) {
      state.sites.push(site);
      await this.save(state);
    }
    return null;
  }

  /** The cron's minute: probe the mini and act on what `decide` says. */
  async check() {
    const healthy = await this.probe();
    const state = await this.state();
    const standbyCounts =
      state.mode === "standby" ? await this.counts(state.sites) : undefined;
    const {
      state: next,
      action,
      warning,
      note,
    } = decide(state, healthy, Date.now(), standbyCounts);
    if (action) {
      // DNS first: if it cannot be changed, nothing else changes either.
      await this.setProxied(action === "failover");
      await this.notify(
        action === "failover"
          ? `🚨 sdk.naru.pub failed over to the read-only standby on Cloudflare: the mini has not answered for ${FAIL_AFTER} minutes and has not reported in.`
          : `✅ sdk.naru.pub is back on the mini: it answered for ${RETURN_AFTER} minutes and holds what the standby held.`,
      );
    }
    if (warning) await this.notify(`⚠️ ${warning}`);
    if (note) await this.notify(note);
    await this.save({ ...next, checkedAt: Date.now(), healthy });
    return { mode: next.mode, healthy, action };
  }

  /**
   * A request that reached sdk.naru.pub here while the mini is up, sent on
   * to origin.sdk.naru.pub. From this object: the Worker's own data center
   * (Los Angeles, for Korea) could not connect to the mini's home line in
   * the 2026-10-15 drill, while this object's probes always did.
   */
  async forward(request: Request): Promise<Response> {
    const url = new URL(request.url);
    url.hostname = this.env.SDK_ORIGIN_HOST!;
    return fetch(new Request(url, request));
  }

  /** By hand, for drills: switch to `mode` now, whatever the checks say. */
  async force(input: { mode: Mode }) {
    if (input?.mode !== "mini" && input?.mode !== "standby")
      throw new Error("Expected mode mini or standby.");
    const state = await this.state();
    await this.setProxied(input.mode === "standby");
    await this.save({
      ...state,
      mode: input.mode,
      failures: 0,
      successes: 0,
      warned: false,
      changedAt: Date.now(),
    });
    await this.notify(`🔧 sdk.naru.pub switched to ${input.mode} by hand.`);
    return null;
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

  private async counts(sites: string[]) {
    const counts: Counts = {};
    for (const site of sites) {
      const stub = this.env.SITES.get(this.env.SITES.idFromName(site));
      const outcome = (await stub.fingerprint()) as Outcome<{
        collections: number;
        documents: number;
      }>;
      if (outcome.ok)
        counts[site] = {
          collections: outcome.value.collections,
          documents: outcome.value.documents,
        };
    }
    return counts;
  }

  /** Turns Cloudflare's proxy on sdk.naru.pub on (standby) or off (mini). */
  private async setProxied(proxied: boolean) {
    const token = this.env.CLOUDFLARE_DNS_TOKEN;
    if (!token) throw new Error("CLOUDFLARE_DNS_TOKEN is not set.");
    const api = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      const body = (await response.json()) as {
        success: boolean;
        result: { id: string }[] & { id: string };
        errors: unknown;
      };
      if (!body.success)
        throw new Error(
          `Cloudflare API ${path}: ${JSON.stringify(body.errors)}`,
        );
      return body.result;
    };
    const domain = this.env.PLATFORM_DOMAIN;
    const [zone] = await api(`/zones?name=${domain}`);
    const [record] = await api(
      `/zones/${zone.id}/dns_records?type=A&name=sdk.${domain}`,
    );
    if (!record) throw new Error(`No A record for sdk.${domain}.`);
    await api(`/zones/${zone.id}/dns_records/${record.id}`, {
      method: "PATCH",
      // Proxied records' TTL is Cloudflare's own; the mini's is a minute.
      body: JSON.stringify({ proxied, ttl: proxied ? 1 : 60 }),
    });
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
