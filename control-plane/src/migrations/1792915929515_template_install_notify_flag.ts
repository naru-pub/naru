import { sql, type Kysely } from "kysely";

// Templates no longer update sites by themselves: an install is told of new
// versions or not (`notify`), and its owner updates it. 'auto' installs, whose
// owners wanted new versions, are told of them now; 'never' installs are not.
// Automatic updates still queued are cancelled. Breaking for the release
// before it, which reads `updates`: deploy with --downtime.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table board_template_installs add column notify boolean not null default true`.execute(
    db,
  );
  await sql`update board_template_installs set notify = (updates <> 'never')`.execute(
    db,
  );
  await sql`alter table board_template_installs drop column updates`.execute(
    db,
  );
  await sql`select absurd.cancel_task('maintenance', task_id)
    from absurd.t_maintenance
    where task_name = 'template-update-v1'
      and state in ('pending', 'running', 'sleeping')`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table board_template_installs add column updates text not null default 'notify'
    check (updates in ('notify', 'auto', 'never'))`.execute(db);
  await sql`update board_template_installs set updates = case when notify then 'notify' else 'never' end`.execute(
    db,
  );
  await sql`alter table board_template_installs drop column notify`.execute(db);
}
