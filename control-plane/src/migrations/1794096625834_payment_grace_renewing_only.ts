import { sql, type Kysely } from "kysely";

// The payment grace window (users.supporter_grace) is now given only while a
// subscription is still renewing: a Toss plan active or scheduled, or a store
// subscription that auto-renews and is active or in billing_retry. A
// cancelled or past-due plan, a refund (which cancels the plan) or a one-time
// purchase has no charge coming to wait for. Kept by
// lib/payments/paid-time.ts (refreshPaymentGrace); backfilled here by the
// same rule.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table users alter column supporter_grace set default false
  `.execute(db);
  await sql`
    update users set supporter_grace = (
      exists (
        select 1 from subscriptions s
        where s.user_id = users.id
          and s.status in ('active', 'scheduled')
      ) or exists (
        select 1 from store_subscriptions s
        where s.user_id = users.id
          and s.auto_renews
          and s.status in ('active', 'billing_retry')
      )
    )
  `.execute(db);
}

// Back to the rule of migration 1792549929453: grace unless the paid time
// ends with a period bought in a store subscription that will not renew.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    alter table users alter column supporter_grace set default true
  `.execute(db);
  await sql`
    update users set supporter_grace = not exists (
      select 1 from store_transactions t
      join store_subscriptions s on s.id = t.store_subscription_id
      where t.user_id = users.id
        and t.revoked_at is null
        and t.period_end >= users.supporter_until
        and not (s.auto_renews and s.status in ('active', 'billing_retry'))
    )
  `.execute(db);
}
