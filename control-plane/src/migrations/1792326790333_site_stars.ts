import { sql, type Kysely } from "kysely";

// Stars: sites an account keeps at hand. An account's, not one client's: the
// Naru app shows them under 별표 in 둘러보기 (docs/design/naru-app.md).
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
    create table site_stars (
      id uuid primary key default uuid_v7(),
      user_id ${userId} not null references users(id) on delete cascade,
      site_user_id ${userId} not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      unique (user_id, site_user_id)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table site_stars`.execute(db);
}
