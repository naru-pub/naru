import { sql, type Kysely } from "kysely";

// Only a site's owner requires a supporter plan of its members now
// (site_member_supporters_only). A site whose members Naru's operators held
// to one keeps that requirement as its owner's, which the owner may lift.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`update users set site_member_supporters_only = true where not site_members_free`.execute(
    db,
  );
  await sql`alter table users drop column site_members_free`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table users add column site_members_free boolean not null default true`.execute(
    db,
  );
}
