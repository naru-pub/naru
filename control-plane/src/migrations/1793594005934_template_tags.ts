import { sql, type Kysely } from "kysely";

// Tags their authors give templates, normalized by lib/board/tags.ts. Browsing
// asks which templates hold a tag, and how many hold each.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table board_templates
      add column tags text[] not null default '{}',
      add constraint board_templates_tags_check check (cardinality(tags) <= 3)
  `.execute(db);
  await sql`
    create index board_templates_tags_idx on board_templates using gin (tags)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    alter table board_templates
      drop constraint board_templates_tags_check,
      drop column tags
  `.execute(db);
}
