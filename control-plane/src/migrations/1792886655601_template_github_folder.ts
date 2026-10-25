import { sql, type Kysely } from "kysely";

// A GitHub-sourced template names the folder of its repository it publishes
// (`github_path`: '' for the repository's root, else 'a/b'), so a workflow
// finds its template by its owner, repository, branch and folder instead of
// an ID that exists only once the template's post does. Templates already
// published by ID keep a null folder and are found by ID alone.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table board_templates add column github_path text`.execute(
    db,
  );
  await sql`
    create unique index board_templates_github_folder
      on board_templates (user_id, github_repository, github_ref, github_path)
      where source = 'github' and github_path is not null
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index board_templates_github_folder`.execute(db);
  await sql`alter table board_templates drop column github_path`.execute(db);
}
