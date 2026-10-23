import { sql, type Kysely } from "kysely";

// Naru MCP (docs/design/naru-mcp.md): apps that connect to an account's site
// through https://naru.pub/mcp, signed in with OAuth 2.1.
//
// - mcp_clients: apps registered themselves (RFC 7591 dynamic registration),
//   unauthenticated, so the name is the app's own claim; the consent page
//   shows the redirect host beside it. Registrations nothing signed in with
//   are pruned after a day.
// - mcp_auth_codes: the one-time codes /mcp/authorize hands the app (PKCE
//   S256), stored as a hash, for 10 minutes.
// - mcp_grants: one per connection, revoked by deleting it. Its access token
//   lasts an hour; its refresh token is replaced on every use, both stored as
//   hashes. previous_refresh_hash is the token the last refresh replaced:
//   seeing it again means two parties hold the connection, so it is revoked.
//
// users.id's type is read, as in migration 1791738861047: the site-data test
// schema keeps integer ids.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  const {
    rows: [{ type }],
  } = await sql<{ type: string }>`
    select format_type(atttypid, atttypmod) as type from pg_attribute
    where attrelid = 'users'::regclass and attname = 'id'
  `.execute(db);
  const userId = sql.raw(type);

  await sql`
    create table mcp_clients (
      id uuid primary key default uuid_v7(),
      name text not null,
      redirect_uris text[] not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index mcp_clients_created_idx on mcp_clients (created_at)`.execute(
    db,
  );

  await sql`
    create table mcp_auth_codes (
      hash text primary key,
      client_id uuid not null references mcp_clients(id) on delete cascade,
      user_id ${userId} not null references users(id) on delete cascade,
      challenge text not null,
      redirect_uri text not null,
      scope text not null,
      expires_at timestamptz not null
    )
  `.execute(db);

  await sql`
    create table mcp_grants (
      id uuid primary key default uuid_v7(),
      user_id ${userId} not null references users(id) on delete cascade,
      client_id uuid not null references mcp_clients(id) on delete cascade,
      scope text not null,
      access_hash text not null unique,
      access_expires_at timestamptz not null,
      refresh_hash text not null unique,
      previous_refresh_hash text unique,
      created_at timestamptz not null default now(),
      last_used_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index mcp_grants_user_idx on mcp_grants (user_id)`.execute(
    db,
  );
  await sql`create index mcp_grants_client_idx on mcp_grants (client_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table mcp_grants`.execute(db);
  await sql`drop table mcp_auth_codes`.execute(db);
  await sql`drop table mcp_clients`.execute(db);
}
