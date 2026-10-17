import { sql, type Kysely } from "kysely";

// A workflow deploy that changes the site's code finalizes before its release
// is activated, which can outlast the request: the release activates in its
// durable task, and the deployment keeps how that went for the workflow to ask.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table github_deployments
    add column functions_release_id uuid,
    add column functions_status text
      check (functions_status in ('activating', 'active', 'refused')),
    add column functions_error jsonb`.execute(db);
  await sql`create index github_deployments_functions_release_id_idx
    on github_deployments (functions_release_id)
    where functions_release_id is not null`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table github_deployments
    drop column functions_release_id,
    drop column functions_status,
    drop column functions_error`.execute(db);
}
