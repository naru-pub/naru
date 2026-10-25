import { sql, type Kysely } from "kysely";

// A board notification is a reply's, or a template version's: someone who
// installed the template and asked to be told (updates = 'notify') hears of
// each version its author publishes, once. Additive: the release before it
// only reads and writes reply notifications, which keep their shape.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table board_notifications
    alter column reply_id drop not null,
    add column version_id uuid references board_template_versions (id) on delete cascade,
    drop constraint board_notifications_reason_check,
    add constraint board_notifications_reason_check check (
      (reason in ('reply_to_post', 'reply_to_reply') and reply_id is not null and version_id is null)
      or (reason = 'template_version' and version_id is not null and reply_id is null)
    )`.execute(db);
  await sql`create unique index board_notifications_version on board_notifications (user_id, version_id) where version_id is not null`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`delete from board_notifications where version_id is not null`.execute(
    db,
  );
  await sql`drop index board_notifications_version`.execute(db);
  await sql`alter table board_notifications
    drop constraint board_notifications_reason_check,
    drop column version_id,
    alter column reply_id set not null,
    add constraint board_notifications_reason_check check (reason in ('reply_to_post', 'reply_to_reply'))`.execute(
    db,
  );
}
