import { sql, type Kysely } from "kysely";

// Whether the custom domain's DNS reaches Naru: its addresses are among the
// custom domain target's. edge-sync checks it (lib/edge/domain-dns.ts), and
// only then does the site's subdomain redirect to the domain and the prompt
// show it. dns_checked_at is when the check last had an answer.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table custom_domains
      add column dns_resolves boolean not null default false,
      add column dns_checked_at timestamptz
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    alter table custom_domains
      drop column dns_resolves,
      drop column dns_checked_at
  `.execute(db);
}
