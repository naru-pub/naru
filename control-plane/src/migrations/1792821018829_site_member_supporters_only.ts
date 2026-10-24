import { sql, type Kysely } from "kysely";

// A site may require its members to support Naru, whatever Naru's operators
// require of them.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table users add column site_member_supporters_only boolean not null default false`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table users drop column site_member_supporters_only`.execute(
    db,
  );
}
