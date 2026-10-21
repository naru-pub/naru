import { sql, type Kysely } from "kysely";

// Whether the paid time ending at supporter_until is followed by the payment
// grace window. It is not when that time was bought in an app store
// subscription that will not renew: no charge is coming to wait for, and the
// store runs its own billing retries. Kept by lib/payments/paid-time.ts
// (refreshPaymentGrace); backfilled here by the same rule.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table users
      add column supporter_grace boolean not null default true
  `.execute(db);
  await sql`
    update users set supporter_grace = false
    where exists (
      select 1 from store_transactions t
      join store_subscriptions s on s.id = t.store_subscription_id
      where t.user_id = users.id
        and t.revoked_at is null
        and t.period_end >= users.supporter_until
        and not (s.auto_renews and s.status in ('active', 'billing_retry'))
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table users drop column supporter_grace`.execute(db);
}
