import { sql, type Kysely } from "kysely";

// Site members: Naru accounts signed in to someone else's site. A member is
// one row per site and account, and its id is what the site sees: documents a
// member writes record it as their author, and nothing else about the account
// reaches the site. Codes and tokens mirror the owner's, tied to the Naru
// session that approved them so signing out of Naru ends them.
//
// Media a member uploads records them too, so their uploads can be limited.
//
// users.id is uuid since migration 1790824144110; the site-data test schema
// predates that and keeps integer ids, so its type is read, not assumed.
export async function up(db: Kysely<any>): Promise<void> {
  const {
    rows: [{ type }],
  } = await sql<{ type: string }>`
    select format_type(atttypid, atttypmod) as type from pg_attribute
    where attrelid = 'users'::regclass and attname = 'id'
  `.execute(db);
  const userId = sql.raw(type);
  await sql`
    create table site_members (
      id uuid primary key default uuid_v7(),
      site_user_id ${userId} not null references users(id) on delete cascade,
      user_id ${userId} not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      unique (site_user_id, user_id)
    )
  `.execute(db);
  await sql`create index site_members_user_idx on site_members (user_id)`.execute(
    db,
  );
  await sql`
    create table site_member_codes (
      hash text primary key,
      member_id uuid not null references site_members(id) on delete cascade,
      session_id text not null references sessions(id) on delete cascade,
      redirect_uri text not null,
      challenge text not null,
      expires_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create table site_member_tokens (
      hash text primary key,
      member_id uuid not null references site_members(id) on delete cascade,
      session_id text not null references sessions(id) on delete cascade,
      origin text not null,
      issued_at timestamptz not null default now(),
      expires_at timestamptz not null
    )
  `.execute(db);
  for (const table of ["site_member_codes", "site_member_tokens"])
    for (const column of ["member_id", "session_id", "expires_at"])
      await sql`create index ${sql.raw(`${table}_${column}_idx`)} on ${sql.table(table)} (${sql.ref(column)})`.execute(
        db,
      );
  await sql`
    alter table site_data_files
    add column member_id uuid references site_members(id) on delete set null
  `.execute(db);
  await sql`
    create index site_data_files_member_idx on site_data_files (member_id, created_at)
    where member_id is not null
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table site_data_files drop column member_id`.execute(db);
  await sql`drop table site_member_tokens, site_member_codes, site_members`.execute(
    db,
  );
}
