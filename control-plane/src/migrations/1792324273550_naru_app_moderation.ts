import { sql, type Kysely } from "kysely";

// Moderation in the Naru app (App Store guideline 1.2, docs/design/naru-app.md):
//
// - app_hidden_sites: sites an account chose not to see. Left out of its
//   showcase and inbox, and what they send it is dropped, until it shows
//   them again.
// - app_reports: reports of a site, or of one notification it sent, for the
//   operators (posted to Discord). A signed-out report has no reporter and is
//   limited by address.
//
// users.id's type is read, as in migration 1791738861047: the site-data test
// schema keeps integer ids.
export async function up(db: Kysely<any>): Promise<void> {
  const {
    rows: [{ type }],
  } = await sql<{ type: string }>`
    select format_type(atttypid, atttypmod) as type from pg_attribute
    where attrelid = 'users'::regclass and attname = 'id'
  `.execute(db);
  const userId = sql.raw(type);

  await sql`
    create table app_hidden_sites (
      id uuid primary key default uuid_v7(),
      user_id ${userId} not null references users(id) on delete cascade,
      site_user_id ${userId} not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      unique (user_id, site_user_id)
    )
  `.execute(db);

  await sql`
    create table app_reports (
      id uuid primary key default uuid_v7(),
      reporter_user_id ${userId} references users(id) on delete set null,
      reporter_ip text,
      site_user_id ${userId} not null references users(id) on delete cascade,
      notification_id uuid references app_notifications(id) on delete set null,
      reason text not null check (reason in ('spam', 'abuse', 'sexual', 'illegal', 'other')),
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index app_reports_reporter_idx on app_reports (reporter_user_id, created_at)`.execute(
    db,
  );
  await sql`create index app_reports_ip_idx on app_reports (reporter_ip, created_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table app_reports`.execute(db);
  await sql`drop table app_hidden_sites`.execute(db);
}
