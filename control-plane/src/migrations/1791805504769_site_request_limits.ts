import { sql, type Kysely } from "kysely";

// Requests to each hosted site, as Cloudflare counts them, and the monthly
// allowance kept against them (lib/edge/site-requests.ts). Every request the
// edge Worker answers is billed, so a site that makes too many is blocked at
// Cloudflare's firewall, before the Worker, for the rest of the month.
//
// site_request_days holds one count per site and UTC day; today's is
// rewritten each run until the day is over. site_request_months records what
// the operators were told for a site's month, so each alert is sent once.
// site_request_overrides is the operators' own word on a site, set from
// /admin/firewall: blocked whatever its count, or never blocked.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table site_request_days (
      id uuid primary key default uuid_v7(),
      user_id uuid not null references users(id) on delete cascade,
      date date not null,
      requests bigint not null,
      unique (user_id, date)
    )
  `.execute(db);
  await sql`
    create table site_request_months (
      id uuid primary key default uuid_v7(),
      user_id uuid not null references users(id) on delete cascade,
      month date not null,
      warned_at timestamptz,
      exceeded_at timestamptz,
      unique (user_id, month)
    )
  `.execute(db);
  await sql`
    create table site_request_overrides (
      id uuid primary key default uuid_v7(),
      user_id uuid not null unique references users(id) on delete cascade,
      mode text not null check (mode in ('block', 'exempt')),
      reason text not null,
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table site_request_overrides`.execute(db);
  await sql`drop table site_request_months`.execute(db);
  await sql`drop table site_request_days`.execute(db);
}
