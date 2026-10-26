import { absurdSchema } from "@/migrations/vendor/absurd-0.5.0";
import { up as naruAppUp } from "@/migrations/1792318382896_naru_app";
import { up as siteModerationUp } from "@/migrations/1792328450234_site_moderation";
import { up as usageUp } from "@/migrations/1791377967407_site_data_usage_counters";
import { up as backendUp } from "@/migrations/1791514826830_site_data_backend";
import { up as removePostgresUp } from "@/migrations/1791519830591_remove_postgres_site_data";
import { up as uuidUp } from "@/migrations/1791346354414_site_data_uuid_columns";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { up as baseUp } from "@/migrations/1788176027971_add_site_database";
import { up as authUp } from "@/migrations/1788177446828_add_site_data_owner_auth";

import { up as sortingUp } from "@/migrations/1788180032055_add_site_data_created_at";

import { up as filterUp } from "@/migrations/1788205003689_add_site_data_filter_index";

import { up as sessionsUp } from "@/migrations/1788206726527_stable_site_clients_and_owner_sessions";

import { up as lifetimeUp } from "@/migrations/1788208716196_configurable_admin_token_lifetime";
import { up as filesUp } from "@/migrations/1788264228670_add_site_data_files";
import { up as fileMetadataUp } from "@/migrations/1788296417049_add_site_data_file_metadata";
import { up as versionUp } from "@/migrations/1788299234629_add_site_data_document_version";
import { up as fileVersionUp } from "@/migrations/1788944200000_add_site_data_file_version";
import { up as dropFileMetadataUp } from "@/migrations/1789273289882_drop_site_data_file_metadata";
import { up as dropFileVersionUp } from "@/migrations/1789273609493_drop_site_data_file_version";
import { up as dropSiteClientsUp } from "@/migrations/1790078516190_drop_site_data_site_clients";
import { up as slideTokensUp } from "@/migrations/1790110700000_slide_site_data_access_tokens";

import { up as orderingUp } from "@/migrations/1790200121054_explicit_document_ordering";
import { up as mediaDeletionUp } from "@/migrations/1791803004027_media_deletion_grants";
import { up as membershipUp } from "@/migrations/1791800344085_site_membership_admission";
import { up as membersUp } from "@/migrations/1791738861047_add_site_members";
import { up as verifiedEmailUp } from "@/migrations/1791981028752_site_member_verified_email";
import { up as supportersOnlyUp } from "@/migrations/1792821018829_site_member_supporters_only";
import { up as managedMediaUp } from "@/migrations/1791981970276_site_data_files_managed";

/**
 * The site-data schema of a disposable naru_data_test database. Documents and
 * collections are in Durable Objects; `postgresSiteData` keeps the PostgreSQL
 * tables they had, for tests of the migrations that once changed them.
 */
export async function setupTestDatabase({ postgresSiteData = false } = {}) {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/naru_data_test")
    throw new Error("Use a disposable naru_data_test database.");
  await sql`create table users(id serial primary key, login_name text not null unique,
    supporter_comp boolean not null default true, supporter_until timestamptz,
    supporter_grace boolean not null default true, deleted_at timestamptz,
    email text, email_verified_at timestamptz)`.execute(db);
  await sql`create table supporter_trials(id serial primary key, user_id integer not null unique references users(id) on delete cascade, email_digest text not null unique, ends_at timestamptz not null)`.execute(
    db,
  );
  await sql`create table subscriptions(id serial primary key, user_id integer not null unique references users(id) on delete cascade, plan text not null default 'supporter')`.execute(
    db,
  );
  await sql`create table sessions(id text primary key, user_id integer not null references users(id) on delete cascade, expires_at timestamptz not null)`.execute(
    db,
  );
  await sql`create table custom_domains(id serial primary key, user_id integer references users(id), hostname text,
    verified_at timestamptz, cloudflare_status text, ssl_status text,
    dns_resolves boolean not null default false, dns_checked_at timestamptz,
    dns_failing_since timestamptz, released_at timestamptz)`.execute(db);
  await baseUp(db);
  await authUp(db);
  await sortingUp(db);
  await filterUp(db);
  await sessionsUp(db);
  await lifetimeUp(db);
  await filesUp(db);
  await fileMetadataUp(db);
  await versionUp(db);
  await fileVersionUp(db);
  await dropFileMetadataUp(db);
  await dropFileVersionUp(db);
  await dropSiteClientsUp(db);
  await slideTokensUp(db);
  await orderingUp(db);
  await uuidUp(db);
  await db.transaction().execute((tx) => usageUp(tx));
  await backendUp(db);
  if (postgresSiteData) return;
  await removePostgresUp(db);
  // Collections are the objects', which name them with UUIDs, as PostgreSQL
  // has since migration 1790824144110; this schema predates that.
  for (const table of [
    "site_data_clients",
    "site_data_auth_codes",
    "site_data_access_tokens",
  ])
    await sql`alter table ${sql.table(table)} alter column collection_ids type uuid[] using collection_ids::text[]::uuid[]`.execute(
      db,
    );
  // Migration 1790817060775 defines it with time-ordered ids; this schema
  // never ran that one, and nothing here depends on the ordering.
  await sql`create function uuid_v7() returns uuid language sql as 'select gen_random_uuid()'`.execute(
    db,
  );
  await membersUp(db);
  await membershipUp(db);
  await verifiedEmailUp(db);
  await supportersOnlyUp(db);
  await managedMediaUp(db);
  await mediaDeletionUp(db);
  // Member sign-in sets the Naru app's consent for the site; a suspended site
  // has no data (site-moderation.ts).
  await naruAppUp(db);
  await siteModerationUp(db);
  await sql.raw(absurdSchema).execute(db);
  await sql`select absurd.create_queue('maintenance')`.execute(db);
  // This isolated fixture keeps legacy integer user ids; production's migrated
  // schema uses UUIDs and is separately validated by migration/codegen checks.
  await sql`create table site_function_releases (
    id uuid primary key default uuid_v7(), user_id integer not null references users(id) on delete cascade,
    revision text not null, created_at timestamptz not null default now())`.execute(
    db,
  );
  await sql`create index site_function_releases_user_generation on site_function_releases(user_id, id)`.execute(
    db,
  );
  // Only what a release's durable task records on a workflow deployment.
  await sql`create table github_deployments (id text primary key,
    functions_release_id uuid, functions_status text, functions_error jsonb)`.execute(
    db,
  );
}
export async function teardownTestDatabase() {
  // The last migrations cannot be reversed, so the schema goes as a whole.
  await sql`drop schema if exists absurd cascade`.execute(db);
  await sql`drop schema public cascade`.execute(db);
  await sql`create schema public`.execute(db);
}
