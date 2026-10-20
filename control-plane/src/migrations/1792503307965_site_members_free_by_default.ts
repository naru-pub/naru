import { sql, type Kysely } from "kysely";

// Site members no longer need a supporter plan, unless Naru's operators
// require one of a site's members.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table users alter column site_members_free set default true`.execute(
    db,
  );
  await sql`update users set site_members_free = true where not site_members_free`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table users alter column site_members_free set default false`.execute(
    db,
  );
}
