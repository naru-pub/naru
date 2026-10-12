import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  for (const table of ["site_data_auth_codes", "site_data_access_tokens"])
    await sql`alter table ${sql.table(table)} add column media_delete boolean not null default false`.execute(
      db,
    );
  await sql`alter table site_data_files add column deleted_at timestamptz,
    add column delete_completed_at timestamptz,
    add column upload_expires_at timestamptz,
    add constraint site_media_deletion_complete check (delete_completed_at is null or deleted_at is not null)`.execute(
    db,
  );
  await sql`create index site_data_files_deleted_idx on site_data_files (deleted_at) where deleted_at is not null`.execute(
    db,
  );
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table site_data_files drop column upload_expires_at, drop column delete_completed_at, drop column deleted_at`.execute(
    db,
  );
  for (const table of ["site_data_auth_codes", "site_data_access_tokens"])
    await sql`alter table ${sql.table(table)} drop column media_delete`.execute(
      db,
    );
}
