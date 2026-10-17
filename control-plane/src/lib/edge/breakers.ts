import {
  answerOf,
  callSiteObject,
  requestWorker,
  siteDataWorker,
} from "@/lib/edge/client";
import {
  operatorAlertsConfigured,
  sendOperatorAlert,
} from "@/lib/operator-alerts";

// Paused statements (edge/src/breaker.ts): a statement of a site's code that
// Naru's workerd stopped at its step budget 3 times within a minute is
// refused for 5 minutes (30 when it is paused again within the hour), since
// each stop held up every site on the mini. The Worker keeps the strikes and
// pauses in its memory; the site's object keeps each pause as a trip, for
// the owner's database page (중지된 쿼리) and the operators, who are told
// once in Discord (`alertBreakerTrips`, the edge-breaker-alerts job).

export type BreakerTrip = {
  id: string;
  /** When it was paused (ms). */
  at: number;
  kind: "query" | "mutation" | "route";
  file: string;
  name: string;
  /** The breaker: kind, function and statement, as the Worker names it. */
  key: string;
  statement: string | null;
  /** The statement, at most 2 KB; null when only the function was known. */
  text: string | null;
  strikes: number;
  until: number;
  repeated: boolean;
  /** When the owner, or a new release, let it run again. */
  clearedAt: number | null;
  notifiedAt: number | null;
  /** Paused now, until then; null once over or cleared. */
  pausedUntil: number | null;
};

/** The site's latest trips, newest first. */
export function siteBreakerTrips(site: string, unnotified = false) {
  return callSiteObject<BreakerTrip[]>(site, "breakerTrips", { unnotified });
}

/** Lets the site's paused statement `key` (or every one) run again. */
export function clearSiteBreaker(site: string, key?: string) {
  return callSiteObject<null>(
    site,
    "clearBreaker",
    key === undefined ? {} : { key },
  );
}

const KST = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Seoul",
});
const KIND = { query: "쿼리", mutation: "뮤테이션", route: "라우트" };

/** The operators' message for one trip. */
export function tripAlert(site: string, trip: BreakerTrip) {
  const minutes = Math.round((trip.until - trip.at) / 60_000);
  return {
    title: `사이트 SQL 일시 중지: ${site}`,
    lines: [
      `${KIND[trip.kind] ?? trip.kind} ${trip.file}:${trip.name} — 1분 안에 ${trip.strikes}번 3초를 넘겨 중지되어 ${KST.format(trip.until)}까지 ${minutes}분 멈춤${trip.repeated ? " (1시간 안에 다시)" : ""}`,
      trip.text === null
        ? "문장은 알 수 없어 함수 전체를 멈춤"
        : `\`\`\`sql\n${trip.text.slice(0, 1200).replaceAll("```", "'''")}\n\`\`\``,
    ],
  };
}

/**
 * Tells the operators of each trip the Worker has not had acknowledged:
 * one message a trip, acknowledged once posted, so a failed post is tried
 * again on the next run. Nothing without a webhook.
 */
export async function alertBreakerTrips() {
  if (!operatorAlertsConfigured()) return { sites: 0, alerted: 0 };
  const target = siteDataWorker();
  const { sites } = await answerOf<{ sites: string[] }>(
    await requestWorker(
      target,
      "/v1/breakers/unnotified",
      "paused statements",
      {
        body: "{}",
        contentType: "application/json",
      },
    ),
    "paused statements",
  );
  let alerted = 0;
  for (const site of sites) {
    const trips = await siteBreakerTrips(site, true);
    const told: string[] = [];
    try {
      for (const trip of [...trips].reverse()) {
        await sendOperatorAlert(tripAlert(site, trip));
        told.push(trip.id);
        alerted += 1;
      }
    } finally {
      // What was posted is kept, even when a later post failed.
      await callSiteObject(site, "ackBreakerTrips", { ids: told });
    }
  }
  return { sites: sites.length, alerted };
}
