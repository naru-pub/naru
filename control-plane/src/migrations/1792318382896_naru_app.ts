import { sql, type Kysely } from "kysely";

// The Naru app (docs/design/naru-app.md): sign-ins from the app, the devices
// they registered for push, which sites each account lets notify it, and the
// notifications sites sent with ctx.notify.
//
// - app_auth_codes: the one-time codes /app/authorize hands the app (PKCE S256),
//   stored as a hash, for 10 minutes. Sign-in happens on naru.pub, so new
//   sign-in methods (TOTP, passkeys) need no app release.
// - app_tokens: one per app sign-in, stored as a hash; revoked by deleting it.
// - app_devices: an APNs or FCM token, owned by the sign-in that registered
//   it, so signing out stops pushes to that device.
// - app_site_consents: pending (the site has sent, the account has not
//   decided), allowed or muted. Without a row a site's notification creates a
//   pending one.
// - app_notifications: per account, after member → account resolution;
//   outbox_id is the site's outbox row, so delivering one twice stores it once.
//   Notifications to a pending site are kept and listed once it is allowed;
//   muted ones are never stored.
// - users.app_notifications_disabled: operators stop a site's notifications.
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
    create table app_auth_codes (
      hash text primary key,
      user_id ${userId} not null references users(id) on delete cascade,
      client text not null check (client in ('ios', 'macos', 'android')),
      challenge text not null,
      redirect_uri text not null,
      expires_at timestamptz not null
    )
  `.execute(db);

  await sql`
    create table app_tokens (
      id uuid primary key default uuid_v7(),
      user_id ${userId} not null references users(id) on delete cascade,
      hash text not null unique,
      client text not null check (client in ('ios', 'macos', 'android')),
      created_at timestamptz not null default now(),
      last_used_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index app_tokens_user_idx on app_tokens (user_id)`.execute(db);

  await sql`
    create table app_devices (
      id uuid primary key default uuid_v7(),
      app_token_id uuid not null references app_tokens(id) on delete cascade,
      platform text not null check (platform in ('apns', 'fcm')),
      token text not null unique,
      environment text not null check (environment in ('sandbox', 'production')),
      bundle_id text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index app_devices_token_idx on app_devices (app_token_id)`.execute(db);

  await sql`
    create table app_site_consents (
      user_id ${userId} not null references users(id) on delete cascade,
      site_user_id ${userId} not null references users(id) on delete cascade,
      state text not null check (state in ('pending', 'allowed', 'muted')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (user_id, site_user_id)
    )
  `.execute(db);

  await sql`
    create table app_notifications (
      id uuid primary key default uuid_v7(),
      user_id ${userId} not null references users(id) on delete cascade,
      site_user_id ${userId} not null references users(id) on delete cascade,
      outbox_id text not null,
      title text not null,
      body text not null,
      path text not null,
      created_at timestamptz not null default now(),
      read_at timestamptz,
      unique (outbox_id, user_id)
    )
  `.execute(db);
  await sql`create index app_notifications_user_idx on app_notifications (user_id, id desc)`.execute(
    db,
  );
  await sql`create index app_notifications_site_idx on app_notifications (site_user_id, created_at)`.execute(
    db,
  );

  await sql`alter table users add column app_notifications_disabled boolean not null default false`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table users drop column app_notifications_disabled`.execute(db);
  await sql`drop table app_notifications`.execute(db);
  await sql`drop table app_site_consents`.execute(db);
  await sql`drop table app_devices`.execute(db);
  await sql`drop table app_tokens`.execute(db);
  await sql`drop table app_auth_codes`.execute(db);
}
