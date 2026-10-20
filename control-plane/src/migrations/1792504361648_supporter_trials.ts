import { sql, type Kysely } from "kysely";

// Free trials of the supporter plan (lib/supporter-trial.ts): one per account
// and one per verified email address, claimed on /supporter while a window
// operators opened on /admin/trials is open. A trial opens
// the plan's features until ends_at; it is not paid time, so it stays out of
// users.supporter_until and the payment ledger. Rows outlive the account
// (deleted accounts are anonymized, not removed) so an address cannot claim
// again; the address is kept only as a digest.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table supporter_trial_windows (
      id uuid primary key default uuid_v7(),
      starts_at timestamptz not null,
      ends_at timestamptz not null check (ends_at > starts_at),
      note text not null default '',
      -- The operator's login name, as other /admin changes record it.
      created_by text not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create table supporter_trials (
      id uuid primary key default uuid_v7(),
      user_id uuid not null unique references users (id),
      email_digest text not null unique,
      -- The window it was claimed in; a window with claims is ended, not
      -- deleted.
      window_id uuid not null references supporter_trial_windows (id),
      claimed_at timestamptz not null default now(),
      ends_at timestamptz not null,
      ending_notice_sent_at timestamptz
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table supporter_trials`.execute(db);
  await sql`drop table supporter_trial_windows`.execute(db);
}
