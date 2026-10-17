"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BreakerTrip } from "@/lib/edge/breakers";

const when = (ms: number) =>
  new Date(ms).toLocaleString("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
const KIND = { query: "쿼리", mutation: "뮤테이션", route: "라우트" };

async function send<T>(body?: { key: string }): Promise<T> {
  const response = await fetch(
    "/api/account/stopped-queries",
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error?.message ?? "중지된 쿼리를 불러오지 못했습니다.",
    );
  return result;
}

/**
 * The site's statements the mini paused (lib/edge/breakers.ts): SQL of the
 * site's code that ran longer than 3 seconds 3 times within a minute, so it
 * was refused for a while. Shown only when there is one; 다시 허용 lets it
 * run again before its time is up, as a new release does.
 */
export default function StoppedQueries() {
  const [trips, setTrips] = useState<BreakerTrip[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const { trips } = await send<{ trips?: BreakerTrip[] }>();
    setTrips(trips ?? []);
  }
  useEffect(() => {
    let active = true;
    send<{ trips?: BreakerTrip[] }>()
      .then(({ trips }) => {
        if (active) setTrips(trips ?? []);
      })
      .catch(() => {
        // Nothing to show: the rest of the page says when the database is away.
      });
    return () => {
      active = false;
    };
  }, []);

  async function allow(trip: BreakerTrip) {
    setBusy(true);
    setError("");
    try {
      await send({ key: trip.key });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "다시 허용하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (!trips.length) return null;
  return (
    <section className="min-w-0 border border-destructive/50 p-5 space-y-4">
      <h2 className="font-bold">중지된 쿼리</h2>
      <p className="text-sm text-muted-foreground">
        사이트 코드의 SQL 문장이 3초를 넘겨 1분 안에 3번 중지되면, 그 문장을 5분
        동안(1시간 안에 다시 그러면 30분) 실행하지 않고 바로 거절합니다. 서버는
        모든 사이트의 데이터베이스를 한 줄로 처리하므로, 오래 걸리는 문장은
        그동안 다른 사이트까지 멈추게 합니다. 인덱스를 더하거나 읽는 행을 줄인
        뒤 새로 릴리스하면 모두 다시 허용되고, 그 전에 다시 허용할 수도
        있습니다.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <ul className="space-y-3">
        {trips.map((trip) => (
          <li key={trip.id} className="border-t pt-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                {when(trip.at)} · {KIND[trip.kind] ?? trip.kind}{" "}
                <code>
                  {trip.file}:{trip.name}
                </code>{" "}
                ·{" "}
                {trip.pausedUntil !== null
                  ? `${when(trip.pausedUntil)}까지 멈춤`
                  : trip.clearedAt !== null
                    ? "다시 허용됨"
                    : "끝남"}
              </p>
              {trip.pausedUntil !== null && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void allow(trip)}
                >
                  다시 허용
                </Button>
              )}
            </div>
            {trip.text !== null ? (
              <pre className="p-3 bg-muted overflow-auto text-xs">
                {trip.text}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">
                어느 문장인지 알 수 없어 함수 전체를 멈췄습니다.
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
