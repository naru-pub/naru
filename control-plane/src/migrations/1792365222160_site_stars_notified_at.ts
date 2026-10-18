import { sql, type Kysely } from "kysely";

// The daily push of starred sites' updates (lib/app-api/starred-updates.ts):
// when the account was last told about each star's site. An update after
// this (or after the star, before the first push) is news.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table site_stars add column notified_at timestamptz`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table site_stars drop column notified_at`.execute(db);
}
