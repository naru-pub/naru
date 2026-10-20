import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { tabLinkClass } from "@/components/ui/tab-link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { STORE_LABELS } from "@/lib/payments/store/products";
import { formatDate } from "../_components/format";
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "앱 구독 · 운영 · 나루" };

const STATUS_LABELS = {
  active: "이용 중",
  billing_retry: "결제 재시도",
  expired: "만료",
  revoked: "회수됨",
} as const;
type StoreStatus = keyof typeof STATUS_LABELS;

const NOTIFICATIONS = 50;

// Supporter plans bought in the Naru apps (lib/payments/store): every App
// Store and Play subscription, and the stores' latest notifications with
// what 나루 did about each (store_notifications).
export default async function StoreSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireOperator();
  const { status: statusParam } = await searchParams;
  const status =
    statusParam && statusParam in STATUS_LABELS
      ? (statusParam as StoreStatus)
      : null;

  const counts = await db
    .selectFrom("store_subscriptions")
    .select(["status", sql<number>`count(*)::int`.as("count")])
    .groupBy("status")
    .execute();
  const countOf = new Map(counts.map((row) => [row.status, row.count]));
  const total = counts.reduce((sum, row) => sum + row.count, 0);

  const subscriptions = await db
    .selectFrom("store_subscriptions as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .select((eb) => [
      "s.id",
      "s.store",
      "s.product_id",
      "s.environment",
      "s.status",
      "s.auto_renews",
      "s.expires_at",
      "s.acknowledged_at",
      "s.cancel_requested_at",
      "s.created_at",
      "s.synced_at",
      "u.login_name",
      "u.deleted_at",
      eb
        .selectFrom("store_transactions as t")
        .select(sql<number>`count(*)::int`.as("count"))
        .whereRef("t.store_subscription_id", "=", "s.id")
        .as("charges"),
      eb
        .selectFrom("store_transactions as t")
        .select(sql<number>`count(*)::int`.as("count"))
        .whereRef("t.store_subscription_id", "=", "s.id")
        .where("t.revoked_at", "is not", null)
        .as("revoked"),
    ])
    .$if(status !== null, (qb) => qb.where("s.status", "=", status!))
    .orderBy("s.updated_at", "desc")
    .limit(200)
    .execute();

  const notifications = await db
    .selectFrom("store_notifications as n")
    .leftJoin("store_subscriptions as s", (join) =>
      join
        .onRef("s.store", "=", "n.store")
        .onRef("s.store_key", "=", "n.store_key"),
    )
    .leftJoin("users as u", "u.id", "s.user_id")
    .select([
      "n.id",
      "n.store",
      "n.notification_type",
      "n.outcome",
      "n.received_at",
      "u.login_name",
    ])
    .orderBy("n.received_at", "desc")
    .limit(NOTIFICATIONS)
    .execute();

  const shown = status ? (countOf.get(status) ?? 0) : total;

  return (
    <div className="space-y-6">
      <nav
        aria-label="상태"
        className="flex min-w-0 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <Link
          href="/admin/store-subscriptions"
          aria-current={status === null ? "page" : undefined}
          className={tabLinkClass(status === null)}
        >
          전체<span className="ml-1.5 tabular-nums">{total}</span>
        </Link>
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <Link
            key={key}
            href={`/admin/store-subscriptions?status=${key}`}
            aria-current={status === key ? "page" : undefined}
            className={tabLinkClass(status === key)}
          >
            {label}
            <span className="ml-1.5 tabular-nums">
              {countOf.get(key as StoreStatus) ?? 0}
            </span>
          </Link>
        ))}
      </nav>

      <div className="space-y-1">
        <h2 className="text-xl font-bold">
          {status ? `앱 구독 · ${STATUS_LABELS[status]}` : "앱 구독"}
        </h2>
        <p className="text-sm text-muted-foreground">
          나루 앱에서 App Store·Google Play로 산 구독입니다. 결제와 환불은
          스토어가 하고, 나루는 알려 준 결제 기간을 이용 기한에 더합니다.{" "}
          {shown}건
          {shown > subscriptions.length
            ? ` · 최근에 바뀐 ${subscriptions.length}건만 표시`
            : ""}
        </p>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>계정</TableHead>
              <TableHead>스토어</TableHead>
              <TableHead>상품</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>만료</TableHead>
              <TableHead className="text-right">결제</TableHead>
              <TableHead>Play 확인</TableHead>
              <TableHead>시작</TableHead>
              <TableHead>동기화</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {subscriptions.map((sub) => (
              <TableRow key={sub.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/admin/users/${encodeURIComponent(sub.login_name)}`}
                    className="underline"
                  >
                    {sub.login_name}
                  </Link>
                  {sub.deleted_at && (
                    <Badge variant="destructive" className="ml-1">
                      삭제됨
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {STORE_LABELS[sub.store]}
                  {sub.environment === "sandbox" && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      샌드박스
                    </span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {sub.product_id}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Badge
                    variant={
                      sub.status === "revoked" || sub.status === "billing_retry"
                        ? "destructive"
                        : "outline"
                    }
                  >
                    {STATUS_LABELS[sub.status]}
                  </Badge>
                  {(sub.status === "active" ||
                    sub.status === "billing_retry") && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {sub.auto_renews
                        ? "갱신"
                        : sub.cancel_requested_at
                          ? "해지 요청됨"
                          : "해지됨"}
                    </span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatDate(sub.expires_at)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {sub.charges ?? 0}
                  {sub.revoked ? (
                    <span className="ml-1 text-xs text-destructive">
                      (회수 {sub.revoked})
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {sub.store === "google"
                    ? formatDate(sub.acknowledged_at)
                    : ""}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatDate(sub.created_at)}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatDate(sub.synced_at)}
                </TableCell>
              </TableRow>
            ))}
            {subscriptions.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="py-10 text-center text-muted-foreground"
                >
                  앱 구독이 없습니다.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Card>

      <div className="space-y-2">
        <h3 className="font-bold">최근 스토어 알림</h3>
        <p className="text-sm text-muted-foreground">
          App Store Server Notifications와 Google Play 실시간 개발자 알림, 최근{" "}
          {NOTIFICATIONS}건과 처리 결과입니다. Play 알림 종류는 숫자(예: 4 구매,
          3 해지, 12 회수, 13 만료)입니다.
        </p>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>받은 시각</TableHead>
                <TableHead>스토어</TableHead>
                <TableHead>종류</TableHead>
                <TableHead>계정</TableHead>
                <TableHead>결과</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {notifications.map((notification) => (
                <TableRow key={notification.id}>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(notification.received_at)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {STORE_LABELS[notification.store]}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {notification.notification_type ?? "-"}
                  </TableCell>
                  <TableCell>
                    {notification.login_name ? (
                      <Link
                        href={`/admin/users/${encodeURIComponent(notification.login_name)}`}
                        className="underline"
                      >
                        {notification.login_name}
                      </Link>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {notification.outcome ?? "-"}
                  </TableCell>
                </TableRow>
              ))}
              {notifications.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-6 text-center text-muted-foreground"
                  >
                    받은 알림이 없습니다.
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
