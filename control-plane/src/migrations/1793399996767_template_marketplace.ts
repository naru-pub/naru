import { sql, type Kysely } from "kysely";

// The template marketplace (docs/marketplace.md): templates with a price,
// bought through Toss on the market MID, and the authors who sell them paid
// out through Toss's 지급대행 (payouts) API.
//
// - market_sellers: an author registered at Toss as a payout seller. Only
//   what 나루 shows back is kept; the account number and the person's
//   contact details live at Toss.
// - template_purchases: the purchase ledger. Rows are never deleted: a
//   payment record outlives the template, the post and the accounts.
// - seller_payouts: one transfer to a seller, covering the purchases that
//   point at it.
//
// users.id's type is read, as in migration 1791738861047.
export async function up(db: Kysely<any>): Promise<void> {
  const {
    rows: [{ type }],
  } = await sql<{ type: string }>`
    select format_type(atttypid, atttypmod) as type from pg_attribute
    where attrelid = 'users'::regclass and attname = 'id'
  `.execute(db);
  const userId = sql.raw(type);

  // Free is 0; a price is whole hundreds of won.
  await sql`
    alter table board_templates
      add column price integer not null default 0,
      add constraint board_templates_price_check
        check (price = 0 or (price between 1000 and 1000000 and price % 100 = 0))
  `.execute(db);

  await sql`
    create table market_sellers (
      id uuid primary key default uuid_v7(),
      user_id ${userId} not null unique references users(id) on delete restrict,
      -- refSellerId: 7 to 20 characters, fixed at registration.
      ref_seller_id text not null unique
        check (char_length(ref_seller_id) between 7 and 20),
      toss_seller_id text unique,
      business_type text not null
        check (business_type in ('INDIVIDUAL', 'INDIVIDUAL_BUSINESS', 'CORPORATE')),
      status text not null default 'APPROVAL_REQUIRED'
        check (status in ('APPROVAL_REQUIRED', 'PARTIALLY_APPROVED', 'KYC_REQUIRED', 'APPROVED')),
      display_name text not null,
      bank_code text not null,
      account_last4 text not null,
      holder_name text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      synced_at timestamptz,
      -- Deleted at Toss; the row stays for the payouts that name it.
      deleted_at timestamptz
    )
  `.execute(db);

  await sql`
    create table seller_payouts (
      id uuid primary key default uuid_v7(),
      seller_id uuid not null references market_sellers(id) on delete restrict,
      amount integer not null check (amount > 0),
      status text not null default 'pending'
        check (status in ('pending', 'requested', 'in_progress', 'completed', 'failed', 'canceled')),
      toss_payout_id text unique,
      -- Toss's yyyy-MM-dd, kept as text: node-postgres would read a date as
      -- local midnight.
      payout_date text check (payout_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      error jsonb,
      requested_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  // One payout in flight per seller: the next waits for its purchases.
  await sql`
    create unique index seller_payouts_one_open_idx on seller_payouts (seller_id)
      where status in ('pending', 'requested', 'in_progress')
  `.execute(db);

  await sql`
    create table template_purchases (
      id uuid primary key default uuid_v7(),
      -- Null once the author's account, and with it the template, is
      -- deleted: the purchase stays on record by its title.
      template_id uuid references board_templates(id) on delete set null,
      buyer_id ${userId} not null references users(id) on delete restrict,
      seller_id uuid not null references market_sellers(id) on delete restrict,
      -- What was bought, as it was named then.
      template_title text not null,
      order_id text not null unique,
      amount integer not null check (amount > 0),
      fee integer not null check (fee >= 0 and fee <= amount),
      status text not null default 'pending'
        check (status in ('pending', 'done', 'failed', 'expired', 'canceled')),
      toss_payment_key text,
      toss_mid text,
      toss_method text,
      toss_receipt_url text,
      charge_attempted_at timestamptz,
      paid_at timestamptz,
      -- Asked for by the buyer: held out of payouts while it is refunded.
      refund_requested_at timestamptz,
      canceled_at timestamptz,
      payout_id uuid references seller_payouts(id) on delete restrict,
      raw jsonb,
      created_at timestamptz not null default now(),
      check (status <> 'done' or (paid_at is not null and canceled_at is null)),
      check (status <> 'canceled' or canceled_at is not null),
      -- In a payout only once paid; refunded from the Toss dashboard
      -- afterwards, it stays in that payout's record.
      check (payout_id is null or status in ('done', 'canceled'))
    )
  `.execute(db);
  await sql`
    create unique index template_purchases_one_done_idx
      on template_purchases (template_id, buyer_id) where status = 'done'
  `.execute(db);
  await sql`
    create index template_purchases_buyer_idx on template_purchases (buyer_id, created_at)
  `.execute(db);
  await sql`
    create index template_purchases_unpaid_idx on template_purchases (seller_id, paid_at)
      where status = 'done' and payout_id is null and refund_requested_at is null
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table template_purchases`.execute(db);
  await sql`drop table seller_payouts`.execute(db);
  await sql`drop table market_sellers`.execute(db);
  await sql`
    alter table board_templates
      drop constraint board_templates_price_check,
      drop column price
  `.execute(db);
}
