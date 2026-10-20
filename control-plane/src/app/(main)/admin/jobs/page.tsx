import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { every } from "@/lib/scheduled-jobs";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "../_components/format";
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "예약 작업 · 운영 · 나루" };

const EVENT_LABELS = {
  stalled: "멈춤",
  resumed: "재개",
  failed: "실패",
  recovered: "복구",
} as const;

const EVENT_LIMIT = 300;

// The scheduled jobs the worker runs (lib/scheduled-jobs.ts), as it last
// checked them, and the stall and failure transitions it alerted the
// operators to on Discord, kept for 90 days.
export default async function ScheduledJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; kind?: string }>;
}) {
  await requireOperator();
  const params = await searchParams;
  const job = params.job?.trim() || null;
  const kind =
    params.kind && params.kind in EVENT_LABELS
      ? (params.kind as keyof typeof EVENT_LABELS)
      : null;

  const [jobs, counts, events] = await Promise.all([
    db
      .selectFrom("cron_jobs")
      .select([
        "name",
        "process",
        "every_seconds",
        "last_started_at",
        "stalled_at",
        "failed_at",
        "failure_message",
        "failure_notified",
      ])
      // Trouble first, then by name.
      .orderBy(sql`(stalled_at is not null or failed_at is not null)`, "desc")
      .orderBy("name")
      .execute(),
    db
      .selectFrom("cron_job_events")
      .select([
        "job_name",
        sql<number>`count(*) filter (where kind = 'stalled')::int`.as("stalls"),
        sql<number>`count(*) filter (where kind = 'failed')::int`.as(
          "failures",
        ),
      ])
      .where("created_at", ">", sql<Date>`now() - interval '7 days'`)
      .groupBy("job_name")
      .execute(),
    db
      .selectFrom("cron_job_events")
      .select(["id", "job_name", "kind", "detail", "created_at"])
      .$if(job !== null, (qb) => qb.where("job_name", "=", job!))
      .$if(kind !== null, (qb) => qb.where("kind", "=", kind!))
      .orderBy("created_at", "desc")
      .limit(EVENT_LIMIT)
      .execute(),
  ]);
  const weekly = new Map(counts.map((row) => [row.job_name, row]));
  const stalledCount = jobs.filter((row) => row.stalled_at).length;
  const failedCount = jobs.filter((row) => row.failed_at).length;

  const href = (changes: { job?: string | null; kind?: string | null }) => {
    const next = new URLSearchParams();
    const nextJob = "job" in changes ? changes.job : job;
    const nextKind = "kind" in changes ? changes.kind : kind;
    if (nextJob) next.set("job", nextJob);
    if (nextKind) next.set("kind", nextKind);
    const query = next.toString();
    return query ? `/admin/jobs?${query}#events` : "/admin/jobs#events";
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">예약 작업</h2>
        <p className="text-sm text-muted-foreground">
          워커가 일정대로 시작하는 작업입니다. 간격에 유예(간격의 10분의 1, 최소
          5분)를 더한 만큼 시작하지 않으면 멈춤, 실패한 뒤 성공하지 않으면
          실패로 운영자 Discord에 알립니다. 작업 {jobs.length}개 · 멈춤{" "}
          {stalledCount} · 실패 {failedCount}.
        </p>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>작업</TableHead>
              <TableHead>간격</TableHead>
              <TableHead>마지막 시작</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>7일간</TableHead>
              <TableHead>마지막 오류</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((row) => {
              const week = weekly.get(row.name);
              return (
                <TableRow key={row.name}>
                  <TableCell className="font-mono text-xs">
                    <Link
                      href={href({ job: row.name, kind: null })}
                      className="underline"
                    >
                      {row.name}
                    </Link>
                    {row.process !== "worker" ? (
                      <span className="text-muted-foreground">
                        {" "}
                        ({row.process})
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {every(row.every_seconds)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(row.last_started_at)}
                  </TableCell>
                  <TableCell className="space-y-1">
                    {row.stalled_at ? (
                      <div className="whitespace-nowrap">
                        <Badge variant="destructive">멈춤</Badge>{" "}
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {formatDate(row.stalled_at)}부터
                        </span>
                      </div>
                    ) : null}
                    {row.failed_at ? (
                      <div className="whitespace-nowrap">
                        <Badge
                          variant={
                            row.failure_notified ? "destructive" : "outline"
                          }
                        >
                          {row.failure_notified ? "실패" : "실패(알림 전)"}
                        </Badge>{" "}
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {formatDate(row.failed_at)}부터
                        </span>
                      </div>
                    ) : null}
                    {!row.stalled_at && !row.failed_at ? (
                      <Badge variant="secondary">정상</Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                    {week ? `멈춤 ${week.stalls} · 실패 ${week.failures}` : "-"}
                  </TableCell>
                  <TableCell className="max-w-md">
                    {row.failure_message ? (
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                        {row.failure_message
                          .trim()
                          .split("\n")
                          .slice(-8)
                          .join("\n")}
                      </pre>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {jobs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-10 text-center text-muted-foreground"
                >
                  등록된 작업이 없습니다.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Card>

      <section id="events" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">
            알림 기록{job ? <span className="font-mono"> · {job}</span> : null}
          </h2>
          <div className="flex flex-wrap gap-2 text-sm">
            <Link
              href={href({ kind: null })}
              className={kind === null ? "font-semibold" : "underline"}
            >
              전체
            </Link>
            {Object.entries(EVENT_LABELS).map(([key, label]) => (
              <Link
                key={key}
                href={href({ kind: key })}
                className={kind === key ? "font-semibold" : "underline"}
              >
                {label}
              </Link>
            ))}
            {job ? (
              <Link href={href({ job: null })} className="underline">
                모든 작업
              </Link>
            ) : null}
          </div>
        </div>
        <Card>
          <ul className="divide-y-2 divide-border text-sm">
            {events.map((event) => (
              <li key={event.id} className="space-y-0.5 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    {formatDate(event.created_at)}
                  </span>
                  <Badge
                    variant={
                      event.kind === "stalled" || event.kind === "failed"
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {EVENT_LABELS[event.kind]}
                  </Badge>
                  <Link
                    href={href({ job: event.job_name })}
                    className="font-mono font-medium text-foreground underline"
                  >
                    {event.job_name}
                  </Link>
                </div>
                {event.detail ? (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                    {event.detail.trim().split("\n").slice(-8).join("\n")}
                  </pre>
                ) : null}
              </li>
            ))}
            {events.length === 0 ? (
              <li className="p-3 text-muted-foreground">기록이 없습니다.</li>
            ) : null}
          </ul>
        </Card>
        {events.length === EVENT_LIMIT ? (
          <p className="text-xs text-muted-foreground">
            최근 {EVENT_LIMIT}건만 보입니다.
          </p>
        ) : null}
      </section>
    </div>
  );
}
