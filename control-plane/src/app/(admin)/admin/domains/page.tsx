import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/database";
import { accessEndsAtOf } from "@/lib/entitlements";
import {
  releaseSchedule,
  type ReleaseReason,
} from "@/lib/custom-domain-housekeeping";
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

export const metadata: Metadata = { title: "커스텀 도메인 · 운영 · 나루" };

const REASONS: Record<ReleaseReason, string> = {
  lapsed: "유료 이용 끝남",
  pending: "연결 안 됨",
  dns: "DNS 안 맞음",
};

// A domain serves once Cloudflare has the hostname and its certificate active
// and its ownership verified.
function isConnected(domain: {
  cloudflare_status: string;
  ssl_status: string | null;
  verified_at: Date | string | null;
}) {
  return (
    domain.cloudflare_status === "active" &&
    domain.ssl_status === "active" &&
    domain.verified_at !== null
  );
}

function verificationErrors(value: unknown): string[] {
  const errors = typeof value === "string" ? safeParse(value) : value;
  return Array.isArray(errors)
    ? errors.filter((error): error is string => typeof error === "string")
    : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export default async function DomainsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireOperator();
  const filter = (await searchParams).status;
  const now = new Date();

  const domains = await db
    .selectFrom("custom_domains")
    .innerJoin("users", "users.id", "custom_domains.user_id")
    .leftJoin("supporter_trials", "supporter_trials.user_id", "users.id")
    .select([
      "custom_domains.id",
      "custom_domains.hostname",
      "custom_domains.cloudflare_status",
      "custom_domains.ssl_status",
      "custom_domains.verified_at",
      "custom_domains.verification_errors",
      "custom_domains.created_at",
      "custom_domains.updated_at",
      "custom_domains.released_at",
      "custom_domains.release_reason",
      "custom_domains.release_notice_sent_at",
      "custom_domains.dns_failing_since",
      "users.login_name",
      "users.supporter_comp",
      "users.supporter_until",
      "users.supporter_grace",
      "supporter_trials.ends_at as trial_ends_at",
    ])
    .orderBy("custom_domains.created_at", "desc")
    .execute();

  const connected = domains.filter(isConnected).length;
  const shown = domains.filter((domain) =>
    filter === "connected"
      ? isConnected(domain)
      : filter === "pending"
        ? !isConnected(domain)
        : true,
  );

  const filters = [
    { value: undefined, label: `전체 ${domains.length}` },
    { value: "connected", label: `연결됨 ${connected}` },
    { value: "pending", label: `연결 중 ${domains.length - connected}` },
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">커스텀 도메인</h2>
        <p className="text-sm text-muted-foreground">
          계정이 연결한 도메인과 Cloudflare의 호스트·인증서 상태입니다. 유료
          이용이 끝난 지 30일, 추가하고 14일 동안 연결되지 않았거나 DNS가 30일
          동안 나루를 가리키지 않은 도메인은 소유자에게 메일로 알린 뒤 7일이
          지나면 연결이 해제됩니다(Cloudflare 호스트 삭제). 해제된 도메인은
          소유자가 다시 연결할 수 있습니다.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {filters.map((option) => (
          <Link
            key={option.label}
            href={
              option.value
                ? `/admin/domains?status=${option.value}`
                : "/admin/domains"
            }
            aria-current={filter === option.value ? "page" : undefined}
            className={
              filter === option.value
                ? "font-bold underline"
                : "text-muted-foreground underline"
            }
          >
            {option.label}
          </Link>
        ))}
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>도메인</TableHead>
              <TableHead>계정</TableHead>
              <TableHead>상태</TableHead>
              <TableHead>유료 이용</TableHead>
              <TableHead>추가</TableHead>
              <TableHead>상태 갱신</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((domain) => {
              const live = isConnected(domain);
              const errors = verificationErrors(domain.verification_errors);
              const accessEndsAt = accessEndsAtOf(domain);
              const schedule = domain.released_at
                ? null
                : releaseSchedule(
                    {
                      createdAt: new Date(domain.created_at),
                      active: live,
                      dnsFailingSince: domain.dns_failing_since
                        ? new Date(domain.dns_failing_since)
                        : null,
                      accessEndsAt,
                      noticeSentAt: domain.release_notice_sent_at
                        ? new Date(domain.release_notice_sent_at)
                        : null,
                    },
                    now.getTime(),
                  );
              return (
                <TableRow key={domain.id}>
                  <TableCell className="font-medium break-all">
                    {live ? (
                      <a
                        href={`https://${domain.hostname}`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        {domain.hostname}
                      </a>
                    ) : (
                      domain.hostname
                    )}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/users/${encodeURIComponent(domain.login_name)}`}
                      className="underline"
                    >
                      {domain.login_name}
                    </Link>
                  </TableCell>
                  <TableCell className="space-y-1">
                    {live ? (
                      <Badge variant="outline">연결됨</Badge>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="secondary">
                          호스트 {domain.cloudflare_status}
                        </Badge>
                        <Badge variant="secondary">
                          SSL {domain.ssl_status ?? "-"}
                        </Badge>
                        {!domain.verified_at && (
                          <span className="text-xs text-muted-foreground">
                            소유 미확인
                          </span>
                        )}
                      </div>
                    )}
                    {domain.release_reason && (
                      <Badge variant="secondary">
                        해제됨 · {REASONS[domain.release_reason]}
                      </Badge>
                    )}
                    {schedule && (
                      <Badge variant="destructive">
                        {schedule.releaseAt
                          ? `${formatDate(schedule.releaseAt)} 해제 · ${REASONS[schedule.reason]}`
                          : `해제 대상 · ${REASONS[schedule.reason]}`}
                      </Badge>
                    )}
                    {errors.map((error) => (
                      <div key={error} className="text-xs text-destructive">
                        {error}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {accessEndsAt === null ? (
                      <Badge variant="secondary">무료 제공</Badge>
                    ) : accessEndsAt > now.getTime() ? (
                      `~ ${formatDate(new Date(accessEndsAt))}`
                    ) : (
                      <Badge variant="destructive">끝남</Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(domain.created_at)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatDate(domain.updated_at)}
                  </TableCell>
                </TableRow>
              );
            })}
            {shown.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-6 text-center text-muted-foreground"
                >
                  도메인이 없습니다.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
