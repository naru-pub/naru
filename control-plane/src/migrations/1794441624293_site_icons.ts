import { sql, type Kysely } from "kysely";

// A site's icon, as the apps and their pushes show it: the site's own
// favicon, rendered to a PNG beside its screenshot (update-screenshots), at
// _icons/<login>.png in the site bucket. Null while the site has none, or
// none has been rendered; otherwise when it was, which versions its URL.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table users add column site_icon_rendered_at timestamptz`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table users drop column site_icon_rendered_at`.execute(db);
}
