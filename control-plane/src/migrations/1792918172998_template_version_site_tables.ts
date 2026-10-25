import { sql, type Kysely } from "kysely";

// The tables a template version's migrations create in the site's database,
// for its post to say so. Worked out from the migration files in storage the
// first time the version is shown, and kept here; null until then.
// Additive: the release before it neither reads nor writes it.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table board_template_versions add column site_tables jsonb`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table board_template_versions drop column site_tables`.execute(
    db,
  );
}
