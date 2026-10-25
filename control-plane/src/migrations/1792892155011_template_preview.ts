import { sql, type Kysely } from "kysely";

// A template's own preview image, which its author uploads (or its workflow
// publishes) for templates whose files alone can't show what they look
// like: an app that needs its site's data or a sign-in. It stands in for the
// screenshot of every version until removed. Its object is
// _templates/<id>/preview; its SHA-256 lets a workflow skip uploading it
// again.
//
// A workflow's upload carries the image it means to set beside the files,
// staged until finalize.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table board_templates
      add column preview_content_type text,
      add column preview_sha256 text,
      add column preview_updated_at timestamptz,
      add constraint board_templates_preview_complete check (
        (preview_content_type is null) = (preview_sha256 is null)
        and (preview_content_type is null) = (preview_updated_at is null)
      )
  `.execute(db);
  await sql`
    alter table board_template_uploads
      add column preview_content_type text,
      add column preview_sha256 text,
      add column preview_size integer,
      add constraint board_template_uploads_preview_complete check (
        (preview_content_type is null) = (preview_sha256 is null)
        and (preview_content_type is null) = (preview_size is null)
      )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    alter table board_template_uploads
      drop constraint board_template_uploads_preview_complete,
      drop column preview_content_type,
      drop column preview_sha256,
      drop column preview_size
  `.execute(db);
  await sql`
    alter table board_templates
      drop constraint board_templates_preview_complete,
      drop column preview_content_type,
      drop column preview_sha256,
      drop column preview_updated_at
  `.execute(db);
}
