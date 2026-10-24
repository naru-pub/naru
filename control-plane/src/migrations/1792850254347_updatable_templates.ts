import { sql, type Kysely } from "kysely";

// Templates that keep the sites they were installed on up to date:
//
// - A template's versions come from its author's site (as before) or from a
//   GitHub Actions workflow (`source` 'github', with the repository and ref
//   its OIDC token must match), staged in board_template_uploads.
// - A version says whether it carries site code (_naru/): such a template
//   installs at a site's root. Existing versions are backfilled from their
//   files.
// - A template file keeps its sha256 (from the workflow's manifest) and its
//   ETag in storage, so an update can tell a file the owner changed.
// - board_template_installs is what a site installed: the template, the
//   version, the folder, the files it wrote (with their ETags then) and
//   whether to update it. Applications before this have no install: they
//   stay as they were and are never updated.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table board_templates
      add column source text not null default 'site'
        check (source in ('site', 'github')),
      add column github_repository text,
      add column github_ref text,
      add column github_repository_id text,
      add constraint board_templates_github_source check (
        source = 'site' or (github_repository is not null and github_ref is not null)
      )
  `.execute(db);

  await sql`
    alter table board_template_versions
      add column site_code boolean not null default false,
      add column github_sha text
  `.execute(db);
  await sql`
    update board_template_versions v set site_code = true
    where exists (
      select 1 from board_template_files f
      where f.version_id = v.id and f.path like '\\_naru/%'
    )
  `.execute(db);

  await sql`
    alter table board_template_files
      add column sha256 text,
      add column etag text
  `.execute(db);

  await sql`
    create table board_template_installs (
      id uuid primary key default uuid_v7(),
      user_id uuid not null references users (id) on delete cascade,
      template_id uuid not null references board_templates (id) on delete cascade,
      version_id uuid not null references board_template_versions (id) on delete cascade,
      -- '' for the whole site, else 'a/b/'.
      target_path text not null,
      updates text not null default 'notify'
        check (updates in ('notify', 'auto', 'never')),
      -- [{ "path": site path, "etag": its ETag when written }]
      files jsonb not null default '[]',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (user_id, template_id, target_path)
    )
  `.execute(db);
  await sql`create index board_template_installs_template on board_template_installs (template_id)`.execute(
    db,
  );

  await sql`
    create table board_template_uploads (
      id text primary key,
      template_id uuid not null references board_templates (id) on delete cascade,
      user_id uuid not null references users (id) on delete cascade,
      status text not null default 'planned'
        check (status in ('planned', 'finalized', 'failed', 'expired')),
      github_repository_id text not null,
      github_ref text not null,
      github_sha text not null,
      upload_prefix text not null,
      manifest jsonb not null,
      uploaded_paths jsonb not null,
      changelog text,
      version_id uuid references board_template_versions (id) on delete set null,
      error_message text,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      finalized_at timestamptz
    )
  `.execute(db);
  await sql`create index board_template_uploads_expiring on board_template_uploads (expires_at) where status = 'planned'`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop table board_template_uploads`.execute(db);
  await sql`drop table board_template_installs`.execute(db);
  await sql`
    alter table board_template_files drop column sha256, drop column etag
  `.execute(db);
  await sql`
    alter table board_template_versions drop column site_code, drop column github_sha
  `.execute(db);
  await sql`
    alter table board_templates
      drop constraint board_templates_github_source,
      drop column source,
      drop column github_repository,
      drop column github_ref,
      drop column github_repository_id
  `.execute(db);
}
