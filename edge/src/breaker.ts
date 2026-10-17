import { createHash } from "node:crypto";
import { DataError } from "../../control-plane/src/lib/site-data/validation";
import type { SiteData } from "./site";
import { interrupted } from "./sql";
import { STATEMENT_PAUSED } from "./types";

// The circuit breaker for a site's statements that run too long. Naru's
// workerd on the mini stops a statement whose step runs past its budget (3
// seconds: seoul/workerd/), but it runs every site on one thread, so each
// stopped statement held up every site for those 3 seconds. A statement a
// page view runs each time would do that again and again. So a statement
// stopped 3 times within a minute is paused: refused before it reaches
// SQLite, for 5 minutes, or 30 when it is paused again within the hour.
//
// What is paused is one statement of one function of one site: the site, the
// kind of call (query, mutation or route), the function (`<file>:<name>`),
// and the statement's text, normalized and hashed (`statementId`). Where the
// statement is not known, the whole function (statement "*").
//
// Strikes are counted in the Worker, not the object: a write the runtime
// stops resets the object, and its memory with it. The Worker's memory lasts
// as long as the workerd process (a restart forgets every strike and pause,
// which errs on letting statements run). The object tells the Worker what it
// ran through `reportStop`, in this module: the object and the Worker that
// calls it run in the same isolate under workerd (one service on the mini,
// and in local runs), so what the object leaves here before the runtime
// resets it is what the Worker reads after its stub threw. The Worker passes
// the site's paused statements to the object with each call, and the object
// refuses a matching statement where ctx.sql would run it (site.ts).

/** A stopped statement's strikes count this long. */
export const STRIKE_WINDOW_MS = 60_000;
/** Strikes within the window that pause the statement. */
export const STRIKES = 3;
/** How long a statement is paused. */
export const PAUSE_MS = 5 * 60_000;
/** How long, when it was last paused within REPEAT_MS. */
export const LONG_PAUSE_MS = 30 * 60_000;
export const REPEAT_MS = 60 * 60_000;
/** The most of a statement's text kept with its trip. */
export const TRIP_TEXT_CHARS = 2048;

export type CallKind = "query" | "mutation" | "route";

/** The call a statement ran in: its site's function. */
export type CallIdentity = { kind: CallKind; file: string; name: string };

/** A statement the runtime stopped, as its object reports it. */
export type Stop = CallIdentity & {
  /** statementId of its text; null when only the function is known. */
  statement: string | null;
  /** Its text, at most TRIP_TEXT_CHARS. */
  text: string | null;
};

/** A paused statement, as the Worker passes it to the object. */
export type Paused = { key: string; until: number };

/** A pause, for its record (site.ts) and the operators. */
export type Trip = Stop & {
  key: string;
  at: number;
  until: number;
  strikes: number;
  /** Paused again within REPEAT_MS, for LONG_PAUSE_MS. */
  repeated: boolean;
};

/** A statement's text, its whitespace collapsed, hashed: what is paused. */
export function statementId(text: string) {
  return createHash("sha256")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("base64url")
    .slice(0, 22);
}

/** The key a stop is counted and paused under. */
export const breakerKey = (stop: CallIdentity & { statement: string | null }) =>
  `${stop.kind}:${stop.file}:${stop.name}:${stop.statement ?? "*"}`;

/** The refusal of a paused statement, until `until`. */
export function pausedRefusal(until: number, now = Date.now()) {
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  const error = new DataError(
    503,
    `This statement of the site's code ran too long and was stopped ${STRIKES} times within a minute, so it is paused for ${minutes} more minute${minutes === 1 ? "" : "s"}. The site's owner has been told.`,
    "UNAVAILABLE",
    { reason: STATEMENT_PAUSED },
  );
  error.retryAfter = Math.max(1, Math.ceil((until - now) / 1000));
  return error;
}

type State = {
  /** When each strike in the window was. */
  strikes: number[];
  until: number;
  /** When it was last paused. */
  tripped: number;
};

/** The breakers of every site, in one Worker's memory. */
export class Breakers {
  private sites = new Map<string, Map<string, State>>();
  /** Sites with a pause the operators have not been told of. */
  readonly unnotified = new Set<string>();

  /**
   * Counts a stopped statement of `site` at `now`, and answers its trip
   * when this strike pauses it.
   */
  strike(site: string, stop: Stop, now: number): Trip | null {
    const key = breakerKey(stop);
    let states = this.sites.get(site);
    if (!states) this.sites.set(site, (states = new Map()));
    const state = states.get(key) ?? { strikes: [], until: 0, tripped: 0 };
    states.set(key, state);
    // A statement already paused never ran: nothing to count.
    if (state.until > now) return null;
    state.strikes = state.strikes.filter((at) => at > now - STRIKE_WINDOW_MS);
    state.strikes.push(now);
    this.prune(now);
    if (state.strikes.length < STRIKES) return null;
    const repeated = state.tripped > 0 && now - state.tripped < REPEAT_MS;
    const strikes = state.strikes.length;
    state.strikes = [];
    state.tripped = now;
    state.until = now + (repeated ? LONG_PAUSE_MS : PAUSE_MS);
    this.unnotified.add(site);
    return { ...stop, key, at: now, until: state.until, strikes, repeated };
  }

  /** The site's paused statements at `now`. */
  paused(site: string, now: number): Paused[] {
    const out: Paused[] = [];
    for (const [key, state] of this.sites.get(site) ?? [])
      if (state.until > now) out.push({ key, until: state.until });
    return out;
  }

  /**
   * Forgets a site's breaker `key`, or all of them: its strikes, its pause
   * and that it was paused, as if it had never been stopped.
   */
  clear(site: string, key?: string) {
    if (key === undefined) this.sites.delete(site);
    else this.sites.get(site)?.delete(key);
  }

  /** Forgets what no longer counts: memory for the statements that matter. */
  private prune(now: number) {
    if (this.size() < 10_000) return;
    for (const [site, states] of this.sites) {
      for (const [key, state] of states)
        if (
          state.until <= now &&
          now - state.tripped >= REPEAT_MS &&
          state.strikes.every((at) => at <= now - STRIKE_WINDOW_MS)
        )
          states.delete(key);
      if (!states.size) this.sites.delete(site);
    }
  }

  private size() {
    let n = 0;
    for (const states of this.sites.values()) n += states.size;
    return n;
  }
}

/** The Worker's breakers. */
export const breakers = new Breakers();

// What each site's object stopped, until the Worker takes it. Bounded: a
// report no Worker takes (none should be left) is dropped past these.
const MAX_REPORTED_SITES = 1000;
const MAX_REPORTS = 20;
const reported = new Map<string, Stop[]>();

/** The object's report of a statement the runtime stopped (site.ts). */
export function reportStop(site: string, stop: Stop) {
  const list = reported.get(site) ?? [];
  if (list.length >= MAX_REPORTS) return;
  if (!reported.has(site)) {
    if (reported.size >= MAX_REPORTED_SITES) return;
    reported.set(site, list);
  }
  list.push(stop);
}

/** Takes what the site's object reported stopping since last asked. */
export function takeStops(site: string): Stop[] {
  const list = reported.get(site) ?? [];
  reported.delete(site);
  return list;
}

/** A list of pauses as the object takes it: well formed, or none. */
export function pausedList(value: unknown): Paused[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Paused =>
        typeof item?.key === "string" && typeof item?.until === "number",
    )
    .slice(0, 100);
}

/**
 * Before the Worker calls the site's object for `call`: the site's paused
 * statements, to pass with it, and the refusal when the whole function is
 * paused (a stop whose statement was not known).
 */
export function admit(site: string, call: CallIdentity, now = Date.now()) {
  const paused = breakers.paused(site, now);
  const whole = paused.find(
    (pause) => pause.key === breakerKey({ ...call, statement: null }),
  );
  return {
    paused,
    refusal: whole ? pausedRefusal(whole.until, now) : undefined,
  };
}

/**
 * After the Worker's call for `call` answered, or threw `thrown`: counts
 * what the site's object reported stopping (its live queries' runs since
 * the last call too), and keeps each pause that makes (recordTrip). A stub
 * that threw the runtime's interrupt with nothing reported counts against
 * the whole function.
 */
export function settle(
  sites: DurableObjectNamespace<SiteData>,
  ctx: Pick<ExecutionContext, "waitUntil">,
  site: string,
  call: CallIdentity,
  thrown?: unknown,
  now = Date.now(),
) {
  const stops = takeStops(site);
  if (!stops.length && thrown !== undefined && interrupted(thrown))
    stops.push({ ...call, statement: null, text: null });
  for (const stop of stops) {
    const trip = breakers.strike(site, stop, now);
    if (trip)
      ctx.waitUntil(recordTrip(sites, site, trip, breakers.paused(site, now)));
  }
}

/**
 * Keeps a pause in the site's object (site.ts `recordBreakerTrip`), with a
 * stub of its own: the call's may be broken by the reset.
 */
async function recordTrip(
  sites: DurableObjectNamespace<SiteData>,
  site: string,
  trip: Trip,
  paused: Paused[],
) {
  console.warn(
    `Paused ${site}'s ${trip.key} until ${new Date(trip.until).toISOString()}`,
  );
  try {
    await sites.get(sites.idFromName(site)).recordBreakerTrip({ trip, paused });
  } catch (error) {
    console.error(`Recording ${site}'s paused statement failed`, error);
  }
}
