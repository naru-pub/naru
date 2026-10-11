import { sql, type Kysely } from "kysely";

// Deploying a repository through Naru's GitHub App rather than a workflow:
// GitHub tells Naru about a push, and Naru fetches the commit and publishes it.
//
// github_installations: an installation of the App a Naru account has linked,
// with the repositories in it the account's GitHub user could read when it
// linked them. An organization installs the App once for everyone, so what a
// member may publish is what they can read, not all the installation holds.
//
// A target with an installation_id deploys through the App. source_dir is the
// repository folder it publishes. pending_sha is the newest pushed commit not
// yet deployed (later pushes replace it, so a burst deploys once), and
// deploying_at marks a deploy in progress, which a deploy that died with its
// process leaves behind for the runner to take over after a while.
// last_error says why the last attempt failed, until one succeeds.
// skipped_paths records the repository files a deployment left out.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    create table github_installations (
      id uuid primary key default uuid_v7(),
      user_id uuid not null references users(id) on delete cascade,
      installation_id bigint not null,
      account_login text not null,
      repository_ids bigint[] not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (user_id, installation_id)
    )
  `.execute(db);
  await sql`create index github_installations_installation_idx on github_installations (installation_id)`.execute(
    db,
  );
  await sql`
    alter table github_deploy_targets
      add column installation_id bigint,
      add column source_dir text not null default '',
      add column pending_sha text,
      add column pending_at timestamptz,
      add column deploying_at timestamptz,
      add column last_error text
  `.execute(db);
  await sql`
    create index github_deploy_targets_pending_idx on github_deploy_targets (pending_at)
    where pending_sha is not null and enabled
  `.execute(db);
  await sql`
    create index github_deploy_targets_installation_idx
    on github_deploy_targets (installation_id, github_repository_id)
    where installation_id is not null
  `.execute(db);
  await sql`
    alter table github_deployments
      add column skipped_paths jsonb not null default '[]'
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table github_deployments drop column skipped_paths`.execute(
    db,
  );
  await sql`drop index github_deploy_targets_installation_idx`.execute(db);
  await sql`drop index github_deploy_targets_pending_idx`.execute(db);
  await sql`
    alter table github_deploy_targets
      drop column installation_id,
      drop column source_dir,
      drop column pending_sha,
      drop column pending_at,
      drop column deploying_at,
      drop column last_error
  `.execute(db);
  await sql`drop table github_installations`.execute(db);
}
