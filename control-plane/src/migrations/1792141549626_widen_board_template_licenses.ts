import { sql, type Kysely } from "kysely";

// Any license that lets people freely redistribute and modify a template,
// not only CC0/CC BY/CC BY-SA. Mirrors LICENSES in src/lib/board/constants.ts.
const LICENSES = [
  "cc0-1.0",
  "unlicense",
  "0bsd",
  "cc-by-4.0",
  "mit",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "isc",
  "zlib",
  "cc-by-sa-4.0",
  "mpl-2.0",
  "lgpl-3.0-or-later",
  "gpl-2.0-or-later",
  "gpl-3.0-or-later",
  "agpl-3.0-or-later",
  "eupl-1.2",
  "ofl-1.1",
];

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table board_templates
      drop constraint board_templates_license_check,
      add constraint board_templates_license_check
        check (license in (${sql.join(LICENSES.map((l) => sql.lit(l)))}))
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    alter table board_templates
      drop constraint board_templates_license_check,
      add constraint board_templates_license_check
        check (license in ('cc-by-4.0', 'cc-by-sa-4.0', 'cc0-1.0'))
  `.execute(db);
}
