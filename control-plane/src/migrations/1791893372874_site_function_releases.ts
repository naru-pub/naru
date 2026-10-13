import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("site_function_releases")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`uuid_v7()`),
    )
    .addColumn("user_id", "uuid", (col) =>
      col.notNull().references("users.id").onDelete("cascade"),
    )
    .addColumn("revision", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createIndex("site_function_releases_user_generation")
    .on("site_function_releases")
    .columns(["user_id", "id"])
    .execute();
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN RAISE EXCEPTION 'Preserve releases and unfinished cleanup tasks; deploy a forward fix'; END $$`.execute(
    db,
  );
}
