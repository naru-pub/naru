import type { Metadata } from "next";
import { sql } from "kysely";
import { Card } from "@/components/ui/card";
import { db } from "@/lib/database";
import { TRIAL_DAYS } from "@/lib/supporter-trial";
import { requireOperator } from "../_components/requireOperator";

export const metadata: Metadata = { title: "무료 체험 · 운영 · 나루" };

const count = (value: number) => new Intl.NumberFormat("ko-KR").format(value);

export default async function TrialsPage() {
  await requireOperator();
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
          결제한 적이 없고 이메일을 인증한 계정이 /supporter에서 {TRIAL_DAYS}일
          무료 체험을 시작할 수 있어요. 커스텀 도메인은 체험에 포함되지 않아요.
          계정과 이메일 주소마다 한 번뿐이에요.
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
    </div>
  );
}
