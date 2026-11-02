import { sql, type Kysely } from "kysely";

// Free trials are always open to claim now (lib/supporter-trial.ts), so the
// claim windows operators opened go. None was ever opened in production, so no
// trial refers to one.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table supporter_trials drop column window_id`.execute(db);
  await sql`drop table supporter_trial_windows`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    create table supporter_trial_windows (
      id uuid primary key default uuid_v7(),
      starts_at timestamptz not null,
      ends_at timestamptz not null check (ends_at > starts_at),
      note text not null default '',
      created_by text not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    alter table supporter_trials
      add column window_id uuid references supporter_trial_windows (id)
  `.execute(db);
}
