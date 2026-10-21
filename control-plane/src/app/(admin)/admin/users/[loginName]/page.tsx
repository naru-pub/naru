import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/database";
import { isCurrentPlan, paidAccessEndsAt } from "@/lib/payments/subscriptions";
import { getHomepageUrl } from "@/lib/site-urls";
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
import { formatDate, formatKrw } from "../../_components/format";
import { SUBSCRIPTION_STATUS_LABELS } from "../../_components/metrics";
import { requireOperator } from "../../_components/requireOperator";
import { SiteMembersFreeToggle } from "../../_components/SiteMembersFreeToggle";
import { MoveStoreSubscriptionButton } from "../../_components/MoveStoreSubscriptionButton";
import { STORE_LABELS } from "@/lib/payments/store/products";
import {
  formatValue,
  METRICS,
  NEAR_LIMIT,
  readAccountUsage,
} from "../../_components/usage";

export const metadata: Metadata = { title: "계정 · 운영 · 나루" };

const RECENT = 10;

export default async function AccountPage({
  params,
}: {
  params: Promise<{ loginName: string }>;
}) {
  await requireOperator();
  const loginName = decodeURIComponent((await params).loginName);
  const now = new Date();

  const user = await db
    .selectFrom("users")
    .leftJoin("subscriptions", (join) =>
      join.onRef("subscriptions.user_id", "=", "users.id").on(isCurrentPlan),
    )
    .select([
      "users.id",
      "users.login_name",
      "users.email",
      "users.email_verified_at",
      "users.created_at",
      "users.deleted_at",
      "users.site_title",
      "users.site_updated_at",
      "users.home_directory_size_bytes_updated_at",
      "users.supporter_comp",
      "users.supporter_until",
      "users.supporter_grace",
      "users.site_members_free",
      "subscriptions.status as subscription_status",
      "subscriptions.billing_interval",
      "subscriptions.next_billing_at",
    ])
    .where("users.login_name", "=", loginName)
    .executeTakeFirst();
  if (!user) notFound();

  const [usage, payments, applications, board, storeSubscriptions] =
    await Promise.all([
      readAccountUsage(now, user.id),
      db
        .selectFrom("payments")
        .select([
          "id",
          "created_at",
          "status",
          "amount",
          "refunded_amount",
          "period_end",
        ])
        .where("user_id", "=", user.id)
        .orderBy("created_at", "desc")
        .limit(RECENT)
        .execute(),
      db
        .selectFrom("board_template_applications as a")
        .leftJoin("board_template_versions as v", "v.id", "a.version_id")
        .leftJoin("board_templates as t", "t.id", "v.template_id")
        .leftJoin("board_posts as p", "p.id", "t.post_id")
        .select([
          "a.id",
          "a.created_at",
          "v.version",
          "t.id as template_id",
          "p.title",
        ])
        .where("a.user_id", "=", user.id)
        .orderBy("a.created_at", "desc")
        .limit(RECENT)
        .execute(),
      db
        .selectFrom("users")
        .select((eb) => [
          eb
            .selectFrom("board_posts")
            .select(eb.fn.countAll<number>().as("count"))
            .where("board_posts.user_id", "=", user.id)
            .where("board_posts.deleted_at", "is", null)
            .as("posts"),
          eb
            .selectFrom("board_replies")
            .select(eb.fn.countAll<number>().as("count"))
            .where("board_replies.user_id", "=", user.id)
            .where("board_replies.deleted_at", "is", null)
            .as("replies"),
        ])
        .where("users.id", "=", user.id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("store_subscriptions")
        .select([
          "id",
          "store",
          "product_id",
          "environment",
          "status",
          "expires_at",
          "auto_renews",
          "created_at",
        ])
        .where("user_id", "=", user.id)
        .orderBy("created_at", "desc")
        .execute(),
    ]);

  const until = user.supporter_until ? new Date(user.supporter_until) : null;
  const plan = user.supporter_comp
    ? { label: "무료 제공", variant: "secondary" as const }
    : until && until > now
      ? { label: "유료", variant: "outline" as const }
      : until && paidAccessEndsAt(until, user.supporter_grace) > now
        ? { label: "결제 유예 중", variant: "destructive" as const }
        : null;
  const userQuery = `user=${encodeURIComponent(user.login_name)}`;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-bold">{user.login_name}</h2>
          {user.deleted_at && <Badge variant="destructive">삭제됨</Badge>}
          {plan ? (
            <Badge variant={plan.variant}>{plan.label}</Badge>
          ) : (
            <span className="text-sm text-muted-foreground">무료</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {!user.deleted_at && (
            <a
              href={getHomepageUrl(user.login_name)}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {user.site_title || "사이트"}
            </a>
          )}
          <Link href={`/admin/events?${userQuery}`} className="underline">
            결제 이벤트
          </Link>
          <Link href={`/admin/records?${userQuery}`} className="underline">
            결제 기록
          </Link>
          <Link href={`/admin/templates?${userQuery}`} className="underline">
            템플릿 적용
          </Link>
          <Link
            href={`/admin/board?author=${encodeURIComponent(user.login_name)}`}
            className="underline"
          >
            게시판 글 {Number(board.posts ?? 0)} · 답글{" "}
            {Number(board.replies ?? 0)}
          </Link>
        </div>
      </div>

      <Card>
        <dl className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field label="가입">{formatDate(user.created_at)}</Field>
          {user.deleted_at && (
            <Field label="삭제">{formatDate(user.deleted_at)}</Field>
          )}
          <Field label="이메일">
            {user.email ?? "-"}
            {user.email && !user.email_verified_at && (
              <span className="ml-1 text-xs text-muted-foreground">
                (미인증)
              </span>
            )}
          </Field>
          <Field label="사이트 수정">{formatDate(user.site_updated_at)}</Field>
          <Field label="이용 기한">
            {user.supporter_comp ? "-" : formatDate(user.supporter_until)}
          </Field>
          <Field label="정기 결제">
            {user.subscription_status
              ? `${SUBSCRIPTION_STATUS_LABELS[user.subscription_status] ?? user.subscription_status} · ${user.billing_interval === "year" ? "연" : "월"}`
              : "-"}
          </Field>
          <Field label="다음 결제">{formatDate(user.next_billing_at)}</Field>
          <Field label="사이트 회원">
            {user.site_members_free ? "누구나 가입 가능" : "후원 플랜 필요"}
            {!user.deleted_at && (
              <span className="ml-2">
                <SiteMembersFreeToggle
                  loginName={user.login_name}
                  free={user.site_members_free}
                />
              </span>
            )}
          </Field>
        </dl>
      </Card>

      <div className="space-y-2">
        <h3 className="font-bold">사용량</h3>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>항목</TableHead>
                <TableHead className="text-right">사용</TableHead>
                <TableHead className="text-right">제한</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {METRICS.map((metric) => {
                const value = Number(usage?.[metric.key] ?? 0);
                const near =
                  metric.limit !== null && value >= metric.limit * NEAR_LIMIT;
                return (
                  <TableRow key={metric.key}>
                    <TableCell className="font-medium">
                      {metric.label}
                      {metric.key === "storage_bytes" && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          (
                          {formatDate(
                            user.home_directory_size_bytes_updated_at,
                          )}{" "}
                          측정)
                        </span>
                      )}
                    </TableCell>
                    <TableCell
                      className={`whitespace-nowrap text-right tabular-nums ${near ? "font-bold text-destructive" : ""}`}
                    >
                      {formatValue(value, metric.unit)}
                      {metric.limit !== null && value > 0 ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          {Math.round((value / metric.limit) * 100)}%
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {metric.limit === null
                        ? "-"
                        : formatValue(metric.limit, metric.unit)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </div>

      <div className="space-y-2">
        <h3 className="font-bold">최근 결제</h3>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>생성</TableHead>
                <TableHead>상태</TableHead>
                <TableHead className="text-right">결제</TableHead>
                <TableHead className="text-right">환불</TableHead>
                <TableHead>기간 끝</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(payment.created_at)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{payment.status}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {formatKrw(payment.amount)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {payment.refunded_amount > 0
                      ? formatKrw(payment.refunded_amount)
                      : "-"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(payment.period_end)}
                  </TableCell>
                </TableRow>
              ))}
              {payments.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-6 text-center text-muted-foreground"
                  >
                    결제가 없습니다.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </Card>
      </div>

      {storeSubscriptions.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-bold">앱 구독</h3>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>스토어</TableHead>
                  <TableHead>상품</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>만료</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {storeSubscriptions.map((sub) => (
                  <TableRow key={sub.id}>
                    <TableCell className="whitespace-nowrap">
                      {STORE_LABELS[sub.store]}
                      {sub.environment === "sandbox" && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          샌드박스
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{sub.product_id}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{sub.status}</Badge>
                      {!sub.auto_renews && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          해지됨
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatDate(sub.expires_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      {!user.deleted_at &&
                        (sub.status === "active" ||
                          sub.status === "billing_retry") && (
                          <MoveStoreSubscriptionButton
                            subscriptionId={sub.id}
                            from={user.login_name}
                          />
                        )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="font-bold">최근 템플릿 적용</h3>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>템플릿</TableHead>
                <TableHead>버전</TableHead>
                <TableHead>적용 시각</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {applications.map((application) => (
                <TableRow key={application.id}>
                  <TableCell>
                    {application.template_id ? (
                      <Link
                        href={`/admin/templates?template=${application.template_id}`}
                        className="underline"
                      >
                        {application.title}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">
                        삭제된 템플릿
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {application.version !== null
                      ? `v${application.version}`
                      : "-"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(application.created_at)}
                  </TableCell>
                </TableRow>
              ))}
              {applications.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="py-6 text-center text-muted-foreground"
                  >
                    템플릿을 적용한 기록이 없습니다.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}
