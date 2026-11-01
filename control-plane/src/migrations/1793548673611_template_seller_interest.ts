import { sql, type Kysely } from "kysely";

// Who would like to sell templates, asked before selling exists: what they
// would sell and for about how much. One answer per person, which they can
// change; it goes with their account.
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
  await sql`
    create table template_seller_interest (
      id uuid primary key default uuid_v7(),
      user_id ${userId} not null unique references users(id) on delete cascade,
      description text not null,
      price_range text not null
        check (price_range in ('under_10k', '10k_30k', '30k_100k', 'over_100k', 'unsure')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table template_seller_interest`.execute(db);
}
