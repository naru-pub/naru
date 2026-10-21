import { db } from "@/lib/database";
import { accessEndsAtOf } from "@/lib/entitlements";
import { CONFIRMATION_MS, replaceEdgeDomains } from "./client";

// The custom domains the edge serves (edge/src/domains.ts): every domain
// active in Cloudflare and verified, whose owner is paid up, mapped to the
// owner's site. The owner is paid up through the grace period after the last
// paid day or through a free trial, or always for a complimentary account, as
// the proxy decided.
//
// The whole table is sent each time, so a domain removed here, or whose owner
// lapsed, is gone from the edge on the next push. syncEdge pushes it every few
// minutes; a change to a domain pushes it at once.
//
// It also lists the sites operators suspended (site-moderation.ts), which the
// edge refuses on every host; a suspension pushes it at once.

/**
 * The domains served now, each with its owner's site, when the owner's paid
 * period ends (null never) and whether its DNS was last found to reach Naru
 * (domain-dns.ts); only `userId`'s when given.
 */
export async function servedCustomDomains(userId?: string) {
  let query = db
    .selectFrom("custom_domains")
    .innerJoin("users", "users.id", "custom_domains.user_id")
    .leftJoin("supporter_trials", "supporter_trials.user_id", "users.id")
    .select([
      "custom_domains.hostname",
      "users.login_name",
      "users.supporter_comp",
      "users.supporter_until",
      "users.supporter_grace",
      "supporter_trials.ends_at as trial_ends_at",
      "custom_domains.dns_resolves",
    ])
    .where("custom_domains.verified_at", "is not", null)
    .where("custom_domains.cloudflare_status", "=", "active")
    .where("custom_domains.ssl_status", "=", "active")
    .where("users.deleted_at", "is", null);
  if (userId) query = query.where("users.id", "=", userId);
  const rows = await query.execute();
  const now = Date.now();
  return rows.flatMap((row) => {
    const entitledUntil = accessEndsAtOf(row);
    if (entitledUntil !== null && entitledUntil <= now) return [];
    return [
      {
        hostname: row.hostname.toLowerCase(),
        login: row.login_name,
        entitledUntil,
        resolves: row.dns_resolves,
      },
    ];
  });
}

/** Sends the edge the current table; returns how many domains it serves. */
export async function pushEdgeDomains() {
  const now = Date.now();
  const domains: Record<
    string,
    { login: string; entitledUntil: number | null; redirect: boolean }
  > = {};
  for (const domain of await servedCustomDomains())
    domains[domain.hostname] = {
      login: domain.login,
      entitledUntil: domain.entitledUntil,
      // The site's subdomain redirects only to a domain that opens.
      redirect: domain.resolves,
    };
  const suspended = await db
    .selectFrom("users")
    .select("login_name")
    .where("site_moderation", "=", "suspended")
    .where("deleted_at", "is", null)
    .orderBy("login_name")
    .execute();
  await replaceEdgeDomains({
    confirmedUntil: now + CONFIRMATION_MS,
    domains,
    suspended: suspended.map((row) => row.login_name),
  });
  return Object.keys(domains).length;
}

/**
 * Pushes the table after a domain changed, so the change is served now
 * rather than at the next sync, which retries it if this fails.
 */
export async function pushEdgeDomainsSoon() {
  try {
    await pushEdgeDomains();
  } catch (error) {
    console.error("Pushing custom domains to the edge failed", error);
  }
}
