"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BreakerTrip } from "@/lib/edge/breakers";
import type { SiteTable } from "@/lib/site-data/site-tables-http";
import { RESTORE_POINT_DAYS } from "@/lib/site-functions/restore-points";
import { MAX_DOCUMENTS, MAX_SITE_BYTES } from "@/lib/site-data/validation";

/** A GitHub deploy whose release the site refused (github_deployments). */
export type RefusedRelease = {
  id: string;
  at: number;
  where: string;
  message: string | null;
};
type RestorePoint = { kind: "release" | "before-restore" | "manual" };
type Usage = {
  documents: number;
  bytes: number;
  requests: { used: number; limit: number; resetsAt: number };
};

const when = (ms: number) =>
  new Date(ms).toLocaleString("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
const count = (n: number) => n.toLocaleString("ko-KR");
const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const KIND = { query: "쿼리", mutation: "뮤테이션", route: "라우트" };

const PANEL = "border-2 border-line bg-card scroll-mt-6";
const HEADING =
  "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-2 border-line bg-muted px-5 py-3.5";
const LINK = "font-bold text-link underline-offset-4 hover:underline";

/** GETs one of the owner's routes /database reads; throws its message. */
async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error?.message ?? result.error ?? "불러오지 못했어요.",
    );
  return result;
}

/** Trips still paused, or paused within the last `days`. */
const recent = (trips: BreakerTrip[], days: number) => {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return trips.filter((trip) => trip.pausedUntil !== null || trip.at > since);
};

/**
 * What went wrong lately: statements the mini paused (the site object keeps
 * its last 50, StoppedQueries.tsx), shown while paused and for `days`
 * after, and the refused GitHub deploys of those days. Errors the code
 * throws aren't recorded, so they aren't here.
 */
export function Problems({
  refused,
  days,
}: {
  refused: RefusedRelease[];
  days: number;
}) {
  const [trips, setTrips] = useState<BreakerTrip[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const { trips } = await get<{ trips?: BreakerTrip[] }>(
      "/api/account/stopped-queries",
    );
    setTrips(recent(trips ?? [], days));
  }
  useEffect(() => {
    let active = true;
    get<{ trips?: BreakerTrip[] }>("/api/account/stopped-queries")
      .then(({ trips }) => {
        if (active) setTrips(recent(trips ?? [], days));
      })
      .catch(() => {
        if (!active) return;
        setTrips([]);
        setError("중지된 쿼리를 불러오지 못했어요.");
      });
    return () => {
      active = false;
    };
  }, [days]);

  async function allow(trip: BreakerTrip) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account/stopped-queries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: trip.key }),
      });
      if (!response.ok)
        throw new Error(
          (await response.json()).error?.message ?? "다시 허용하지 못했어요.",
        );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "다시 허용하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  const rows = [
    ...(trips ?? []).map((trip) => ({
      at: trip.at,
      key: trip.id,
      where: `${trip.file}:${trip.name}`,
      what: (
        <>
          <span className="font-bold text-destructive">중지된 쿼리</span> —{" "}
          {KIND[trip.kind] ?? trip.kind}의{" "}
          {trip.text === null ? "함수 전체" : "한 문장"}가 3초를 넘어{" "}
          {trip.pausedUntil !== null
            ? `${when(trip.pausedUntil)}까지 쉬어요`
            : trip.clearedAt !== null
              ? "멈췄다가 다시 허용됐어요"
              : "멈췄다가 다시 돌아요"}
        </>
      ),
      action:
        trip.pausedUntil !== null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void allow(trip)}
          >
            다시 허용
          </Button>
        ) : null,
    })),
    ...refused.map((release) => ({
      at: release.at,
      key: release.id,
      where: release.where,
      what: (
        <>
          <span className="font-bold text-destructive">거절된 릴리스</span>
          {release.message && ` — ${release.message}`}
        </>
      ),
      action: (
        <a href="#releases" className={`${LINK} text-sm`}>
          릴리스 보기
        </a>
      ),
    })),
  ].sort((a, b) => b.at - a.at);

  return (
    <section id="problems" aria-labelledby="problems-h" className={PANEL}>
      <div className={HEADING}>
        <h2 id="problems-h" className="text-lg font-bold">
          문제{" "}
          {trips !== null && rows.length > 0 && (
            <span className="text-destructive">{rows.length}</span>
          )}
        </h2>
        <span className="text-sm text-muted-foreground">
          중지된 쿼리와 GitHub에서 거절된 릴리스를 {days}일 동안 보여 줘요
        </span>
      </div>
      {error && (
        <p role="alert" className="px-5 pt-4 text-destructive">
          {error}
        </p>
      )}
      {trips === null ? (
        <p className="p-5 text-sm text-muted-foreground">불러오는 중…</p>
      ) : rows.length === 0 && !error ? (
        <p className="p-5 text-sm text-muted-foreground">
          지금은 문제가 없어요.
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li
              key={row.key}
              className="grid gap-x-4 gap-y-1 border-b border-border px-5 py-4 last:border-b-0 md:grid-cols-[9rem_minmax(0,14rem)_minmax(0,1fr)_auto] md:items-center"
            >
              <span className="text-sm text-muted-foreground">
                {when(row.at)}
              </span>
              <code className="break-all text-sm">{row.where}</code>
              <span className="break-words text-sm">{row.what}</span>
              {row.action && <span>{row.action}</span>}
            </li>
          ))}
        </ul>
      )}
      {trips !== null && trips.length > 0 && (
        <p className="border-t border-border px-5 py-3 text-sm text-muted-foreground">
          SQL 전체는{" "}
          <Link href="/database" className={LINK}>
            데이터베이스
          </Link>
          의 중지된 쿼리에 있어요. 새로 릴리스하면 모두 다시 허용돼요.
        </p>
      )}
    </section>
  );
}

function Meter({
  label,
  used,
  limit,
  shown,
}: {
  label: string;
  used: number;
  limit: number;
  shown: string;
}) {
  const share = Math.min(1, used / limit);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-bold">{label}</span>
        <span className="font-mono text-muted-foreground">{shown}</span>
      </div>
      <div
        role="img"
        aria-label={`${label} ${Math.round(share * 100)}%`}
        className="h-3 border-2 border-line bg-background"
      >
        <div
          className={`h-full ${share >= 0.8 ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * The site's database and this month's usage, from the routes /database
 * reads: its tables, restore points and usage. `migrations` are the
 * current release's, which it applied when it became active.
 */
export function DatabaseAndUsage({
  migrations,
}: {
  migrations: string[] | null;
}) {
  const [tables, setTables] = useState<SiteTable[] | null>(null);
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const failed = (e: unknown) =>
      setError(e instanceof Error ? e.message : "불러오지 못했어요.");
    get<{ tables: SiteTable[] }>("/api/account/site-tables")
      .then(({ tables }) => setTables(tables))
      .catch(failed);
    get<{ restorePoints: RestorePoint[] }>("/api/account/restore-points")
      .then(({ restorePoints }) => setPoints(restorePoints))
      .catch(failed);
    get<{ usage?: Usage }>("/api/account/database")
      .then(({ usage }) => setUsage(usage ?? null))
      .catch(failed);
  }, []);

  const shownMigrations =
    migrations && migrations.length > 4
      ? [...migrations.slice(0, 3), `… ${migrations.at(-1)}`]
      : migrations;

  return (
    <>
      <section id="database" aria-labelledby="database-h" className={PANEL}>
        <div className={HEADING}>
          <h2 id="database-h" className="text-lg font-bold">
            데이터베이스
          </h2>
          <Link href="/database?tab=tables" className={`${LINK} text-sm`}>
            데이터베이스 관리 →
          </Link>
        </div>
        <div className="flex flex-col gap-5 p-5">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <h3 className="font-bold">
              지금 릴리스의 마이그레이션{" "}
              {migrations && (
                <span className="font-normal text-muted-foreground">
                  {migrations.length}개
                </span>
              )}
            </h3>
            {migrations === null ? (
              <p className="text-sm text-muted-foreground">
                릴리스가 없거나 읽지 못했어요.
              </p>
            ) : migrations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <code>_naru/migrations/</code>가 비어 있어요.
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5 font-mono text-sm">
                {shownMigrations!.map((name) => (
                  <li key={name} className="break-all">
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-sm">
            {tables === null
              ? error
                ? "테이블을 읽지 못했어요."
                : "테이블을 불러오는 중…"
              : `테이블 ${count(tables.filter((t) => !t.view).length)}개 · 뷰 ${count(tables.filter((t) => t.view).length)}개`}
          </p>
          <div className="flex flex-col gap-1">
            <h3 className="font-bold">복원 지점</h3>
            <p className="text-sm text-muted-foreground">
              {points === null
                ? error
                  ? "읽지 못했어요."
                  : "불러오는 중…"
                : `릴리스 전에 ${points.filter((p) => p.kind === "release").length}개 · 직접 남긴 것 ${points.filter((p) => p.kind === "manual").length}개 · 복원 전에 ${points.filter((p) => p.kind === "before-restore").length}개, ${RESTORE_POINT_DAYS}일 동안 보관해요`}
            </p>
            <Link href="/database?tab=restore" className={`${LINK} text-sm`}>
              복원 지점 보기
            </Link>
          </div>
        </div>
      </section>

      <section id="usage" aria-labelledby="usage-h" className={PANEL}>
        <div className={HEADING}>
          <h2 id="usage-h" className="text-lg font-bold">
            사용량
          </h2>
          {usage && (
            <span className="text-sm text-muted-foreground">
              요청은{" "}
              {new Date(usage.requests.resetsAt).toLocaleDateString("ko-KR")}에
              초기화
            </span>
          )}
        </div>
        <div className="flex flex-col gap-5 p-5">
          {usage === null ? (
            <p className="text-sm text-muted-foreground">
              {error ? "사용량을 읽지 못했어요." : "불러오는 중…"}
            </p>
          ) : (
            <>
              <Meter
                label="이번 달 요청"
                used={usage.requests.used}
                limit={usage.requests.limit}
                shown={`${count(usage.requests.used)} / ${count(usage.requests.limit)}`}
              />
              <Meter
                label="문서"
                used={usage.documents}
                limit={MAX_DOCUMENTS}
                shown={`${count(usage.documents)} / ${count(MAX_DOCUMENTS)}`}
              />
              <Meter
                label="데이터 용량"
                used={usage.bytes}
                limit={MAX_SITE_BYTES}
                shown={`${mib(usage.bytes)} / ${mib(MAX_SITE_BYTES)} MiB`}
              />
            </>
          )}
        </div>
      </section>
    </>
  );
}
