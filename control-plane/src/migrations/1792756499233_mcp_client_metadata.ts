import { sql, type Kysely } from "kysely";

// MCP apps that identify themselves with a Client ID Metadata Document
// (lib/mcp/client-metadata.ts) instead of registering: their client_id is
// the document's https URL. Each document Naru has read gets an mcp_clients
// row like a registration's, so codes and grants reference it the same way;
// metadata_url is the client_id the app sends, and fetched_at says when the
// document was last read, to read it again after a day.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table mcp_clients
      add column metadata_url text unique,
      add column fetched_at timestamptz
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    alter table mcp_clients
      drop column fetched_at,
      drop column metadata_url
  `.execute(db);
}
