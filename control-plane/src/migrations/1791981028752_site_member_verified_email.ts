import { sql, type Kysely } from "kysely";

// A site may require its members' Naru accounts to have a verified email.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table users add column site_member_verified_email boolean not null default false`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table users drop column site_member_verified_email`.execute(
    db,
  );
}
