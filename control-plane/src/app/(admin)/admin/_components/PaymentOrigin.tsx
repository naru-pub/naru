import { sql } from "kysely";
import { db } from "@/lib/database";
import { formatDate } from "./format";

// Look at settled payments, not attempt-key prefixes: the renewal worker
// also processes scheduled first charges, including retries after declines.
export async function paymentOrigins(paymentIds: string[]) {
  if (paymentIds.length === 0) return new Map<string, PaymentOriginData>();
  const rows = await db
    .selectFrom("payments as p")
    .leftJoin("subscriptions as s", "s.id", "p.subscription_id")
    .leftJoin("supporter_trials as t", "t.user_id", "p.user_id")
    .select([
      "p.id",
      "p.subscription_id",
      "p.paid_at",
      "p.created_at",
      "s.billing_interval",
      "s.created_at as registered_at",
      "t.claimed_at",
      "t.ends_at",
      sql<boolean>`exists (
        select 1 from payments prior
        where prior.subscription_id = p.subscription_id
          and prior.id <> p.id and prior.paid_at is not null
          and prior.paid_at < coalesce(p.paid_at, p.created_at)
      )`.as("has_prior_payment"),
      sql<Date | null>`(
        select min(e.created_at) from payment_events e
        where e.subscription_id = p.subscription_id
          and e.kind = 'subscription_scheduled'
          and e.created_at <= coalesce(p.paid_at, p.created_at)
      )`.as("scheduled_at"),
    ])
    .where("p.id", "in", paymentIds)
    .execute();
  return new Map(rows.map((row) => [row.id, row]));
}

type PaymentOriginData = {
  subscription_id: string | null;
  billing_interval: string | null;
  registered_at: Date | null;
  claimed_at: Date | null;
  ends_at: Date | null;
  scheduled_at: Date | null;
  has_prior_payment: boolean;
};

export function PaymentOrigin({ origin }: { origin?: PaymentOriginData }) {
  if (!origin) return null;
  if (!origin.subscription_id) return <span>한 번만 결제</span>;
  const interval = origin.billing_interval === "year" ? "연간" : "월간";
  const first = !origin.has_prior_payment;
  const trialDeferred =
    first &&
    origin.scheduled_at &&
    origin.claimed_at &&
    origin.ends_at &&
    origin.claimed_at <= origin.scheduled_at &&
    origin.ends_at > origin.scheduled_at;
  return (
    <div className="space-y-1 text-sm">
      <div>
        {trialDeferred ? "무료 체험 후 " : ""}
        {first ? `첫 ${interval} 결제` : `${interval} 갱신`}
      </div>
      <div className="text-xs text-muted-foreground">
        등록 {formatDate(origin.registered_at)}
        {first && origin.scheduled_at && (
          <div>첫 결제 예약 등록 {formatDate(origin.scheduled_at)}</div>
        )}
        {trialDeferred && (
          <div>무료 체험 종료 {formatDate(origin.ends_at)}</div>
        )}
      </div>
    </div>
  );
}
