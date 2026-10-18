import { db } from "@/lib/database";
import { addPaymentGrace } from "@/lib/payments/subscriptions";
import { getHomepageUrl } from "@/lib/site-urls";

// Where the apps open a site: its custom domain when the edge serves one
// (the conditions of lib/edge/domains.ts: active, verified, owner paid up),
// otherwise <login>.naru.pub. A site's pages keep their member sign-in in
// that origin's storage, so a notification must open the address the site
// is used at. Resolved whenever a notification is listed or pushed, so a
// site that gains or drops a domain is opened at its current one.

export interface AppSiteRow {
  login_name: string;
  site_title: string | null;
}

/** Each site's address, by login name; the oldest served custom domain wins. */
export async function siteOrigins(loginNames: string[]) {
  const origins = new Map(
    loginNames.map((name) => [name, getHomepageUrl(name)] as const),
  );
  if (!loginNames.length) return origins;
  const rows = await db
    .selectFrom("custom_domains")
    .innerJoin("users", "users.id", "custom_domains.user_id")
    .select([
      "custom_domains.hostname",
      "users.login_name",
      "users.supporter_comp",
      "users.supporter_until",
    ])
    .where("users.login_name", "in", [...new Set(loginNames)])
    .where("custom_domains.verified_at", "is not", null)
    .where("custom_domains.cloudflare_status", "=", "active")
    .where("custom_domains.ssl_status", "=", "active")
    .where("users.deleted_at", "is", null)
    .orderBy("custom_domains.verified_at", "desc")
    .execute();
  const now = Date.now();
  // Newest first, so the oldest is set last and wins.
  for (const row of rows) {
    const paid =
      row.supporter_comp ||
      (row.supporter_until !== null &&
        addPaymentGrace(row.supporter_until).getTime() > now);
    if (paid)
      origins.set(row.login_name, `https://${row.hostname.toLowerCase()}`);
  }
  return origins;
}

/** How the apps show a site: its name, title and address. */
export function appSite(site: AppSiteRow, origins: Map<string, string>) {
  return {
    name: site.login_name,
    title: site.site_title,
    url: origins.get(site.login_name) ?? getHomepageUrl(site.login_name),
    iconUrl: null,
  };
}

/** A path a site gave ctx.notify, at the site's address. */
export function pageUrl(origin: string, path: string) {
  return new URL(path, origin + "/").href;
}
