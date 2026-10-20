import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "kysely";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db } from "@/lib/database";
import { REPORT_REASON_LABELS } from "@/lib/app-api/moderation";
import { formatDate } from "../_components/format";
import { requireOperator } from "../_components/requireOperator";
import { SiteLookup } from "./ModerationControls";
import { LevelBadge } from "./LevelBadge";

export const metadata: Metadata = { title: "사이트 관리 · 운영 · 나루" };

const REPORT_DAYS = 30;

const siteLink = (login: string) => (
  <Link
    href={`/admin/moderation/${encodeURIComponent(login)}`}
    className="font-mono text-link underline-offset-4 hover:underline"
  >
    {login}
  </Link>
);

// Reports from the apps, and what operators did about sites.
export default async function ModerationPage() {
  await requireOperator();
  const [reported, moderated] = await Promise.all([
    db
      .selectFrom("app_reports as r")
      .innerJoin("users as s", "s.id", "r.site_user_id")
      .select([
        "s.login_name",
        "s.site_moderation",
        sql<number>`count(*)::int`.as("reports"),
        sql<number>`count(distinct coalesce(r.reporter_user_id::text, r.reporter_ip))::int`.as(
          "reporters",
        ),
        sql<Date>`max(r.created_at)`.as("last_at"),
        sql<string[]>`array_agg(distinct r.reason)`.as("reasons"),
      ])
      .where(
        "r.created_at",
        ">",
        sql<Date>`now() - make_interval(days => ${REPORT_DAYS})`,
      )
      .where("s.deleted_at", "is", null)
      .groupBy(["s.login_name", "s.site_moderation"])
      .orderBy(sql`max(r.created_at)`, "desc")
      .limit(100)
      .execute(),
    db
      .selectFrom("users as s")
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("site_moderation_actions as a")
            .leftJoin("users as o", "o.id", "a.operator_user_id")
            .select(["a.reason", "a.created_at", "o.login_name as operator"])
            .whereRef("a.site_user_id", "=", "s.id")
            .orderBy("a.created_at", "desc")
            .limit(1)
            .as("last"),
        (join) => join.onTrue(),
      )
      .select([
        "s.login_name",
        "s.site_moderation",
        "last.reason",
        "last.created_at",
        "last.operator",
      ])
      .where("s.site_moderation", "is not", null)
      .where("s.deleted_at", "is", null)
      .orderBy("last.created_at", "desc")
      .execute(),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">사이트 관리</h2>
        <p className="text-sm text-muted-foreground">
          목록에서 숨긴 사이트는 홈, /sites, 앱의 둘러보기와 검색에 나오지
          않아요. 서비스를 중지한 사이트는 페이지, 파일, 사용자 도메인, 데이터,
          앱 알림이 모두 멈춰요. 바꾼 내용은 기록에 남고 운영 Discord 채널에
          알려요.
        </p>
      </div>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">사이트 열기</h3>
        <SiteLookup />
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">신고된 사이트 (최근 {REPORT_DAYS}일)</h3>
        {reported.length === 0 ? (
          <p className="text-sm text-muted-foreground">신고가 없어요.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>사이트</TableHead>
                <TableHead>신고</TableHead>
                <TableHead>사유</TableHead>
                <TableHead>마지막 신고</TableHead>
                <TableHead>조치</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reported.map((row) => (
                <TableRow key={row.login_name}>
                  <TableCell>{siteLink(row.login_name)}</TableCell>
                  <TableCell>
                    {row.reports}건 · {row.reporters}명
                  </TableCell>
                  <TableCell>
                    {row.reasons
                      .map(
                        (reason) =>
                          REPORT_REASON_LABELS[
                            reason as keyof typeof REPORT_REASON_LABELS
                          ] ?? reason,
                      )
                      .join(", ")}
                  </TableCell>
                  <TableCell>{formatDate(row.last_at)}</TableCell>
                  <TableCell>
                    <LevelBadge level={row.site_moderation} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">조치 중인 사이트</h3>
        {moderated.length === 0 ? (
          <p className="text-sm text-muted-foreground">없어요.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>사이트</TableHead>
                <TableHead>조치</TableHead>
                <TableHead>사유</TableHead>
                <TableHead>언제</TableHead>
                <TableHead>누가</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {moderated.map((row) => (
                <TableRow key={row.login_name}>
                  <TableCell>{siteLink(row.login_name)}</TableCell>
                  <TableCell>
                    <LevelBadge level={row.site_moderation} />
                  </TableCell>
                  <TableCell className="max-w-md whitespace-pre-wrap">
                    {row.reason ?? "-"}
                  </TableCell>
                  <TableCell>{formatDate(row.created_at)}</TableCell>
                  <TableCell>{row.operator ?? "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
