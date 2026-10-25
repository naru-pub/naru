import { sql, type Kysely } from "kysely";

// The board keeps only templates and showcased sites (사이트 자랑): question
// (질문) and chat (잡담) posts are deleted with their replies, likes and
// notifications, and the solved reply that only questions had goes. Breaking
// for the release before it, which reads `solved_reply_id`: deploy with
// --downtime.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`delete from board_posts where kind in ('question', 'chat')`.execute(
    db,
  );
  await sql`alter table board_posts drop column solved_reply_id`.execute(db);
  await sql`alter table board_posts drop constraint board_posts_kind_check`.execute(
    db,
  );
  await sql`alter table board_posts add constraint board_posts_kind_check
    check (kind in ('site', 'template'))`.execute(db);
}

// The deleted posts don't come back.
export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table board_posts drop constraint board_posts_kind_check`.execute(
    db,
  );
  await sql`alter table board_posts add constraint board_posts_kind_check
    check (kind in ('site', 'template', 'question', 'chat'))`.execute(db);
  await sql`alter table board_posts add column solved_reply_id uuid
    references board_replies (id) on delete set null`.execute(db);
}
