import { sql, type Kysely } from "kysely";

// SDK 1.1.0 no longer deletes media from a page: the control panel's media
// library does. An owner sign-in has no deletion grant to keep. Breaking for
// the release before it, which writes the column: deploy with --downtime.
export async function up(db: Kysely<any>): Promise<void> {
  for (const table of ["site_data_auth_codes", "site_data_access_tokens"])
    await sql`alter table ${sql.table(table)} drop column media_delete`.execute(
      db,
    );
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ["site_data_auth_codes", "site_data_access_tokens"])
    await sql`alter table ${sql.table(table)} add column media_delete boolean not null default false`.execute(
      db,
    );
}
