import { db } from "@/lib/database";

// Authorization codes and access tokens were only ever swept
// opportunistically, by the next request that happened to touch the same
// owner. A site that is signed into once and then left alone keeps its
// expired rows forever. None of that is load-bearing, so a periodic sweep is
// the whole fix. (Public-write rate limits are counted in each site's Durable
// Object, which drops its old buckets itself.)
async function main() {
  const expiredCodes = await db
    .deleteFrom("site_data_auth_codes")
    .where("expires_at", "<=", new Date())
    .executeTakeFirst();
  const expiredTokens = await db
    .deleteFrom("site_data_access_tokens")
    .where("expires_at", "<=", new Date())
    .executeTakeFirst();
  // Members' grants, the same way.
  const expiredMemberCodes = await db
    .deleteFrom("site_member_codes")
    .where("expires_at", "<=", new Date())
    .executeTakeFirst();
  const expiredMemberTokens = await db
    .deleteFrom("site_member_tokens")
    .where("expires_at", "<=", new Date())
    .executeTakeFirst();
  // The Naru app's sign-in codes (lib/app-api/tokens.ts).
  const expiredAppCodes = await db
    .deleteFrom("app_auth_codes")
    .where("expires_at", "<=", new Date())
    .executeTakeFirst();
  const rows = (deleted: { numDeletedRows: bigint } | undefined) =>
    Number(deleted?.numDeletedRows ?? 0);
  console.log(
    `[site-data-cleanup] Removed ${rows(expiredCodes)} codes, ` +
      `${rows(expiredTokens)} tokens, ` +
      `${rows(expiredMemberCodes)} member codes, ` +
      `${rows(expiredMemberTokens)} member tokens, ` +
      `${rows(expiredAppCodes)} app codes`,
  );
}

main().finally(() => db.destroy());
