import { sql, type Kysely } from "kysely";

// Supporter plans bought in the Naru apps, through the App Store and Google
// Play (lib/payments/store). The stores charge, renew, retry and refund; these
// tables keep what they reported, and the periods it paid for feed
// users.supporter_until beside the Toss ledger (lib/payments/paid-time).
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  // One per store subscription: an App Store original transaction, a Play
  // purchase token. Its account is the one the purchase was bound to
  // (appAccountToken, obfuscatedExternalAccountId) and never changes.
  await sql`
    create table store_subscriptions (
      id uuid primary key default uuid_v7(),
      user_id uuid not null references users (id),
      store text not null check (store in ('apple', 'google')),
      store_key text not null,
      product_id text not null,
      environment text not null check (environment in ('sandbox', 'production')),
      status text not null
        check (status in ('active', 'billing_retry', 'expired', 'revoked')),
      expires_at timestamptz not null,
      auto_renews boolean not null,
      -- Play refunds a purchase not acknowledged within three days.
      acknowledged_at timestamptz,
      -- Play only: auto-renewal to be switched off (the account is deleted).
      cancel_requested_at timestamptz,
      synced_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (store, store_key)
    )
  `.execute(db);
  await sql`create index store_subscriptions_user_idx on store_subscriptions (user_id)`.execute(
    db,
  );

  // One per period a store charged for: an App Store transaction, a Play
  // order. A revoked one (refunded, or access taken back) stops counting.
  await sql`
    create table store_transactions (
      id uuid primary key default uuid_v7(),
      store_subscription_id uuid not null references store_subscriptions (id),
      user_id uuid not null references users (id),
      store text not null check (store in ('apple', 'google')),
      store_transaction_id text not null,
      purchased_at timestamptz not null,
      period_end timestamptz not null,
      revoked_at timestamptz,
      price_micros bigint,
      currency text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (store, store_transaction_id)
    )
  `.execute(db);
  await sql`create index store_transactions_user_idx on store_transactions (user_id)`.execute(
    db,
  );

  // Every notification the stores sent, as received, for /admin and replay.
  await sql`
    create table store_notifications (
      id uuid primary key default uuid_v7(),
      store text not null check (store in ('apple', 'google')),
      received_at timestamptz not null default now(),
      notification_type text,
      store_key text,
      payload jsonb,
      outcome text
    )
  `.execute(db);
  await sql`create index store_notifications_received_idx on store_notifications (received_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table store_notifications`.execute(db);
  await sql`drop table store_transactions`.execute(db);
  await sql`drop table store_subscriptions`.execute(db);
}
