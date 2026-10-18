import { sql } from "kysely";
import { db } from "@/lib/database";
import { getRenderedSiteUrl } from "@/lib/site-urls";
import { hiddenSiteIds } from "./moderation";
import { siteOrigins } from "./sites";

export const SHOWCASE_PAGE_SIZE = 48;

/** Longest search the apps may send. */
export const SEARCH_MAX_LENGTH = 50;

/**
 * The apps' 둘러보기: the rows of /sites, discoverable sites with a screenshot,
 * newest update first; for a signed-in account, without the sites it hid.
 * With a search, only the sites whose name or title contains it, a site named
 * exactly that first.
 */
export async function showcasePage(page: number, userId?: string, search?: string) {
  let query = db
    .selectFrom("users")
    .select(["login_name", "site_rendered_at", "site_updated_at"])
    .where("discoverable", "=", true)
    .where("deleted_at", "is", null)
    .where("site_rendered_at", "is not", null)
    .$if(Boolean(search), (q) => {
      const pattern = `%${search!.replace(/[\\%_]/g, "\\$&")}%`;
      return q
        .where((eb) =>
          eb.or([
            eb("login_name", "ilike", pattern),
            eb("site_title", "ilike", pattern),
          ]),
        )
        .orderBy(sql`lower(login_name) = lower(${search})`, "desc");
    })
    .orderBy("site_updated_at", "desc")
    .orderBy("id", "desc")
    .limit(SHOWCASE_PAGE_SIZE + 1)
    .offset((page - 1) * SHOWCASE_PAGE_SIZE);
  if (userId) query = query.where("id", "not in", hiddenSiteIds(userId));
  const rows = await query.execute();
  const shown = rows.slice(0, SHOWCASE_PAGE_SIZE);
  const origins = await siteOrigins(shown.map((row) => row.login_name));
  return {
    sites: shown.map((row) => ({
      name: row.login_name,
      url: origins.get(row.login_name)!,
      screenshotUrl: getRenderedSiteUrl(row.login_name, row.site_rendered_at),
      updatedAt: new Date(
        row.site_updated_at ?? row.site_rendered_at ?? 0,
      ).toISOString(),
    })),
    next: rows.length > SHOWCASE_PAGE_SIZE ? page + 1 : null,
  };
}
