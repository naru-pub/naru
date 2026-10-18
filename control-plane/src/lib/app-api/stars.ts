import { db } from "@/lib/database";
import { getRenderedSiteUrl } from "@/lib/site-urls";
import { siteOrigins } from "./sites";
import type { AppUser } from "./tokens";

// The apps' 별표 in 둘러보기: the account's stars (lib/site-stars.ts) as
// showcase cards. Unlike the showcase, a starred site is listed whether or
// not it is discoverable: the account chose it. Hiding a site unstars it.
// Signed out, the apps keep stars on the device and star them here after
// sign-in.

/** The account's stars, most recent first, as showcase cards. */
export async function listStarredSites(user: AppUser) {
  const rows = await db
    .selectFrom("site_stars as st")
    .innerJoin("users as s", "s.id", "st.site_user_id")
    .select([
      "s.login_name",
      "s.site_rendered_at",
      "s.site_updated_at",
      "st.created_at",
    ])
    .where("st.user_id", "=", user.id)
    .where("s.deleted_at", "is", null)
    .orderBy("st.created_at", "desc")
    .execute();
  const origins = await siteOrigins(rows.map((row) => row.login_name));
  return {
    sites: rows.map((row) => ({
      name: row.login_name,
      url: origins.get(row.login_name)!,
      screenshotUrl: getRenderedSiteUrl(row.login_name, row.site_rendered_at),
      updatedAt: new Date(
        row.site_updated_at ?? row.site_rendered_at ?? row.created_at,
      ).toISOString(),
      starredAt: new Date(row.created_at).toISOString(),
    })),
  };
}
