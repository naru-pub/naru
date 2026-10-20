import { sql, type Kysely } from "kysely";

// The stall and failure transitions of scheduled jobs (lib/scheduled-jobs.ts),
// the ones the operators are alerted to, kept for /admin/jobs. Rows outlive
// the job (a job no longer scheduled is dropped from cron_jobs), so they name
// it rather than reference it. Pruned after 90 days.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table cron_job_events (
      id uuid primary key default uuid_v7(),
      job_name text not null,
      kind text not null
        check (kind in ('stalled', 'resumed', 'failed', 'recovered')),
      detail text,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index cron_job_events_created_at_idx
      on cron_job_events (created_at desc)
  `.execute(db);
  await sql`
    create index cron_job_events_job_name_created_at_idx
      on cron_job_events (job_name, created_at desc)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table cron_job_events`.execute(db);
}
