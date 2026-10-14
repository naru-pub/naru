import { sql, type Kysely } from "kysely";

// Uploads made with { managed: true }: their site's documents keep them, and
// they are deleted once none uses them.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table site_data_files add column managed boolean not null default false`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table site_data_files drop column managed`.execute(db);
}
