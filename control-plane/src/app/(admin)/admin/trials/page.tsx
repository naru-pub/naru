import type { Metadata } from "next";
import { sql } from "kysely";
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
import { db } from "@/lib/database";
import { listTrialWindows, TRIAL_DAYS } from "@/lib/supporter-trial";
import { formatDate } from "../_components/format";
import { requireOperator } from "../_components/requireOperator";
import { TrialWindowButtons, TrialWindowForm } from "./TrialWindowControls";

export const metadata: Metadata = { title: "무료 체험 · 운영 · 나루" };

const count = (value: number) => new Intl.NumberFormat("ko-KR").format(value);

export default async function TrialsPage() {
  await requireOperator();
  const now = new Date();
  const windows = await listTrialWindows();
  const totals = await db
    .selectFrom("supporter_trials as t")
    .select(({ fn }) => [
      fn.countAll<string>().as("claimed"),
      sql<string>`count(*) filter (where t.ends_at > now())`.as("running"),
      // Accounts that paid once their trial started: a charge settled since.
      sql<string>`count(*) filter (where exists (
        select 1 from payments p
        where p.user_id = t.user_id and p.status in ('done', 'canceled')
          and p.paid_at >= t.claimed_at))`.as("paid"),
    ])
    .executeTakeFirstOrThrow();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-bold">무료 체험</h2>
        <p className="text-sm text-muted-foreground">
          아래 신청 기간 동안 결제한 적이 없고 이메일을 인증한 계정이
          /supporter에서 {TRIAL_DAYS}일 무료 체험을 시작할 수 있어요. 계정과
          이메일 주소마다 한 번뿐이라, 기간을 새로 열어도 이미 체험한 사람은
          다시 받지 못해요. 기간이 끝나도 시작한 체험은 이어져요.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">신청</p>
          <p className="text-2xl font-bold">{count(Number(totals.claimed))}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">체험 중</p>
          <p className="text-2xl font-bold">{count(Number(totals.running))}</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">체험 뒤 결제</p>
          <p className="text-2xl font-bold">{count(Number(totals.paid))}</p>
        </Card>
      </div>

      <Card className="space-y-4 p-4">
        <h3 className="font-bold">신청 기간</h3>
        <TrialWindowForm />
        {windows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            신청 기간이 없어요. 지금은 아무도 무료 체험을 시작할 수 없어요.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>상태</TableHead>
                <TableHead>기간</TableHead>
                <TableHead>메모</TableHead>
                <TableHead className="text-right">신청</TableHead>
                <TableHead>추가한 사람</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {windows.map((window) => {
                const open = window.startsAt <= now && window.endsAt > now;
                return (
                  <TableRow key={window.id}>
                    <TableCell>
                      {open ? (
                        <Badge>진행 중</Badge>
                      ) : window.startsAt > now ? (
                        <Badge variant="outline">예정</Badge>
                      ) : (
                        <Badge variant="secondary">끝남</Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(window.startsAt)} ~{" "}
                      {formatDate(window.endsAt)}
                    </TableCell>
                    <TableCell>{window.note || "-"}</TableCell>
                    <TableCell className="text-right">
                      {count(window.claims)}
                    </TableCell>
                    <TableCell>{window.createdBy}</TableCell>
                    <TableCell>
                      <TrialWindowButtons
                        id={window.id}
                        open={open}
                        claims={window.claims}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
