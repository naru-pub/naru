import { db } from "@/lib/database";
import { getRenderedSiteUrl } from "@/lib/site-urls";
import { placeholderScreenshotUrl } from "./showcase";
import { siteOrigins } from "./sites";
import type { AppUser } from "./tokens";

// The apps' 별표 in 둘러보기: the account's stars (lib/site-stars.ts) as
// showcase cards. Unlike the showcase, a starred site is listed whether or
// not it is discoverable or hidden by operators: the account chose it. Its
// screenshot is shown either way (cli/update-screenshots.tsx renders starred
// sites too), except the placeholder for one operators hid. A suspended site is left out. Hiding a
// site unstars it.
// Signed out, the apps keep stars on the device and star them here after
// sign-in.

/** The account's stars, most recent first, as showcase cards. */
export async function listStarredSites(user: AppUser) {
  const rows = await db
    .selectFrom("site_stars as st")
    .innerJoin("users as s", "s.id", "st.site_user_id")
    .select([
      "s.login_name",
      "s.site_moderation",
      "s.site_rendered_at",
      "s.site_updated_at",
      "st.created_at",
    ])
    .where("st.user_id", "=", user.id)
    .where("s.deleted_at", "is", null)
    .where((eb) =>
      eb.or([eb("s.site_moderation", "is", null), eb("s.site_moderation", "!=", "suspended")]),
    )
    .orderBy("st.created_at", "desc")
    .execute();
  const origins = await siteOrigins(rows.map((row) => row.login_name));
  return {
    sites: rows.map((row) => ({
      name: row.login_name,
      url: origins.get(row.login_name)!,
      screenshotUrl:
        !row.site_moderation && row.site_rendered_at
          ? getRenderedSiteUrl(row.login_name, row.site_rendered_at)
          : placeholderScreenshotUrl(),
      updatedAt: new Date(
        row.site_updated_at ?? row.site_rendered_at ?? row.created_at,
      ).toISOString(),
      starredAt: new Date(row.created_at).toISOString(),
    })),
  };
}
