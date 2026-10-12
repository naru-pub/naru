import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table users add column site_member_admission text not null default 'open'
    check (site_member_admission in ('open', 'approval', 'closed'))`.execute(
    db,
  );
  await sql`alter table site_members add column status text not null default 'approved'
    check (status in ('pending', 'approved', 'banned'))`.execute(db);
  await sql`create index site_members_status_idx on site_members (site_user_id, status, id)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table site_members drop column status`.execute(db);
  await sql`alter table users drop column site_member_admission`.execute(db);
}
