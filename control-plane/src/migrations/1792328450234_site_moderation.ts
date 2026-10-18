import { sql, type Kysely } from "kysely";

// What operators do about a site (/admin/moderation), apart from the owner's
// own discoverable switch:
//
// - users.site_moderation: null, 'hidden' (kept out of everything that
//   lists or searches sites: the home page, /sites, the apps' showcase and
//   search) or 'suspended' (hidden, and Naru stops serving the site).
// - site_moderation_actions: each change, with who made it and why. A null
//   level lifts the moderation.
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
    alter table users add column site_moderation text
      check (site_moderation in ('hidden', 'suspended'))
  `.execute(db);

  await sql`
    create table site_moderation_actions (
      id uuid primary key default uuid_v7(),
      site_user_id ${userId} not null references users(id) on delete cascade,
      level text check (level in ('hidden', 'suspended')),
      reason text not null,
      operator_user_id ${userId} references users(id) on delete set null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index site_moderation_actions_site_idx
      on site_moderation_actions (site_user_id, created_at)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table site_moderation_actions`.execute(db);
  await sql`alter table users drop column site_moderation`.execute(db);
}
