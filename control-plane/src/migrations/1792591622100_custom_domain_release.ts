import { sql, type Kysely } from "kysely";

// Housekeeping releases a custom domain that is no longer served — its owner
// lapsed, it never validated, or its DNS stopped reaching Naru — by deleting
// its Cloudflare hostname, which Cloudflare bills, while keeping the row, so
// the owner can connect it again in one step (lib/custom-domain-housekeeping).
// A released domain has no Cloudflare hostname, hence the nullable id.
// dns_failing_since is when the DNS check (lib/edge/domain-dns.ts) first
// found a served domain not reaching Naru, cleared once it does.
// `any` is required here since migrations should be frozen in time.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    alter table custom_domains
      alter column cloudflare_hostname_id drop not null,
      add column released_at timestamptz,
      add column release_reason text
        check (release_reason in ('lapsed', 'pending', 'dns')),
      add column release_notice_sent_at timestamptz,
      add column dns_failing_since timestamptz,
      add constraint custom_domains_released_check check (
        (released_at is null) = (release_reason is null)
        and (released_at is null or cloudflare_hostname_id is null)
      )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`delete from custom_domains where released_at is not null`.execute(
    db,
  );
  await sql`
    alter table custom_domains
      drop constraint custom_domains_released_check,
      drop column released_at,
      drop column release_reason,
      drop column release_notice_sent_at,
      drop column dns_failing_since,
      alter column cloudflare_hostname_id set not null
  `.execute(db);
}
