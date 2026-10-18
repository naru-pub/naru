import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { REPORT_REASON_LABELS } from "@/lib/app-api/moderation";
import { db } from "@/lib/database";
import { getHomepageUrl } from "@/lib/site-urls";
import { formatDate } from "../../_components/format";
import { requireOperator } from "../../_components/requireOperator";
import { LevelBadge } from "../LevelBadge";
import { ModerationForm } from "../ModerationControls";

export const metadata: Metadata = { title: "사이트 관리 · 운영 · 나루" };

// One site: what operators did about it, why, and the reports against it.
export default async function SiteModerationPage({
  params,
}: {
  params: Promise<{ login: string }>;
}) {
  await requireOperator();
  const login = decodeURIComponent((await params).login).toLowerCase();
  const site = await db
    .selectFrom("users")
    .select([
      "id",
      "login_name",
      "site_title",
      "discoverable",
      "site_moderation",
      "app_notifications_disabled",
      "site_updated_at",
    ])
    .where("login_name", "=", login)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!site) notFound();

  const [actions, reports] = await Promise.all([
    db
      .selectFrom("site_moderation_actions as a")
      .leftJoin("users as o", "o.id", "a.operator_user_id")
      .select([
        "a.id",
        "a.level",
        "a.reason",
        "a.created_at",
        "o.login_name as operator",
      ])
      .where("a.site_user_id", "=", site.id)
      .orderBy("a.created_at", "desc")
      .execute(),
    db
      .selectFrom("app_reports as r")
      .leftJoin("users as u", "u.id", "r.reporter_user_id")
      .leftJoin("app_notifications as n", "n.id", "r.notification_id")
      .select([
        "r.id",
        "r.reason",
        "r.created_at",
        "r.reporter_ip",
        "u.login_name as reporter",
        "n.title as notification_title",
        "n.body as notification_body",
        "n.path as notification_path",
      ])
      .where("r.site_user_id", "=", site.id)
      .orderBy("r.created_at", "desc")
      .limit(200)
      .execute(),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          href="/admin/moderation"
          className="text-sm text-link underline-offset-4 hover:underline"
        >
          ← 사이트 관리
        </Link>
        <h2 className="font-mono text-xl font-bold">{site.login_name}</h2>
        <p className="text-sm text-muted-foreground">
          {site.site_title ?? "제목 없음"} ·{" "}
          <a
            href={getHomepageUrl(site.login_name)}
            className="text-link underline-offset-4 hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            사이트 열기
          </a>{" "}
          ·{" "}
          <Link
            href={`/admin/users/${encodeURIComponent(site.login_name)}`}
            className="text-link underline-offset-4 hover:underline"
          >
            계정
          </Link>
        </p>
      </div>

      <Card className="space-y-4 p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted-foreground">조치</dt>
          <dd>
            <LevelBadge level={site.site_moderation} />
          </dd>
          <dt className="text-muted-foreground">공개 목록 (주인 설정)</dt>
          <dd>{site.discoverable ? "공개" : "비공개"}</dd>
          <dt className="text-muted-foreground">앱 알림</dt>
          <dd>{site.app_notifications_disabled ? "꺼짐" : "켜짐"}</dd>
          <dt className="text-muted-foreground">마지막 수정</dt>
          <dd>{formatDate(site.site_updated_at)}</dd>
        </dl>
        <ModerationForm login={site.login_name} level={site.site_moderation} />
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">조치 기록</h3>
        {actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">기록이 없어요.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>언제</TableHead>
                <TableHead>조치</TableHead>
                <TableHead>사유</TableHead>
                <TableHead>누가</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {actions.map((action) => (
                <TableRow key={action.id}>
                  <TableCell>{formatDate(action.created_at)}</TableCell>
                  <TableCell>
                    {action.level ? (
                      <LevelBadge level={action.level} />
                    ) : (
                      "해제"
                    )}
                  </TableCell>
                  <TableCell className="max-w-md whitespace-pre-wrap">
                    {action.reason}
                  </TableCell>
                  <TableCell>{action.operator ?? "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">신고 ({reports.length}건)</h3>
        {reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">신고가 없어요.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>언제</TableHead>
                <TableHead>사유</TableHead>
                <TableHead>신고자</TableHead>
                <TableHead>신고한 알림</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell>{formatDate(report.created_at)}</TableCell>
                  <TableCell>{REPORT_REASON_LABELS[report.reason]}</TableCell>
                  <TableCell>
                    {report.reporter ?? (
                      <span className="text-muted-foreground">
                        로그인하지 않음
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-md whitespace-pre-wrap">
                    {report.notification_title ? (
                      <>
                        <strong>{report.notification_title}</strong>
                        {report.notification_body
                          ? `\n${report.notification_body}`
                          : ""}
                        <span className="block text-xs text-muted-foreground">
                          {report.notification_path}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">사이트 전체</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
