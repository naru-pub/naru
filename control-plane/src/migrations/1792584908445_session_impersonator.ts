import { sql, type Kysely } from "kysely";

// An operator viewing the control plane as another account (/admin/users/...)
// is signed into a session of that account that names the operator's own
// session; ending it signs the operator back into that one. The operator's
// session ending (signing out elsewhere, expiring) ends it too.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table sessions
      add column impersonator_session_id text
        references sessions (id) on delete cascade
  `.execute(db);
  await sql`
    create index sessions_impersonator_session_id_idx
      on sessions (impersonator_session_id)
      where impersonator_session_id is not null
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table sessions drop column impersonator_session_id`.execute(
    db,
  );
}
