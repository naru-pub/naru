import { sql, type Kysely } from "kysely";

// Visitors, signed in to nothing, may upload to a site's media when its owner
// lets them: `off` (the default), `images`, or `all` of the types Naru
// stores. Each upload records who made it (the owner, a member or a visitor),
// which member_id alone cannot say once a member is deleted, and a visitor's
// keeps the address it came from (null where Naru was not told one), which
// limits them and stays for the operators, never shown to the site.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table users add column site_visitor_uploads text not null default 'off'
    check (site_visitor_uploads in ('off', 'images', 'all'))`.execute(db);
  await sql`alter table site_data_files
    add column uploader text not null default 'owner'
      check (uploader in ('owner', 'member', 'visitor')),
    add column visitor_address inet`.execute(db);
  await sql`update site_data_files set uploader = 'member' where member_id is not null`.execute(
    db,
  );
  await sql`create index site_data_files_visitor_idx on site_data_files (user_id, created_at)
    where uploader = 'visitor'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table site_data_files drop column visitor_address, drop column uploader`.execute(
    db,
  );
  await sql`alter table users drop column site_visitor_uploads`.execute(db);
}
