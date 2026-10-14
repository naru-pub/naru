import { sql, type Kysely } from "kysely";

// Sites Naru's operators exempt from the supporter plan members otherwise need.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table users add column site_members_free boolean not null default false`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table users drop column site_members_free`.execute(db);
}
