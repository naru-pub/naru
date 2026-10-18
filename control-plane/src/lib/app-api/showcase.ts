import { sql, type ExpressionBuilder } from "kysely";
import { db } from "@/lib/database";
import type { DB } from "@/lib/db";
import { getRenderedSiteUrl } from "@/lib/site-urls";
import { hiddenSiteIds } from "./moderation";
import { siteOrigins } from "./sites";

export const SHOWCASE_PAGE_SIZE = 48;

/** Longest search the apps may send. */
export const SEARCH_MAX_LENGTH = 50;

/** Where a card's screenshot is not shown: a site that is not listed. */
export function placeholderScreenshotUrl() {
  const origin =
    process.env.SITE_DATA_CONTROL_PLANE_ORIGIN ||
    `https://${process.env.NEXT_PUBLIC_DOMAIN || "naru.pub"}`;
  return new URL("/app/no-preview.png", origin).href;
}

export interface CardRow {
  login_name: string;
  discoverable: boolean;
  site_moderation: "hidden" | "suspended" | null;
  site_rendered_at: Date | null;
}

/**
 * A card's screenshot: the rendered page of a listed site. Other sites get the
 * placeholder, so the app shows neither a stale page of a site its owner took
 * out of the listing nor one operators hid.
 */
export function cardScreenshotUrl(row: CardRow) {
  return row.discoverable && !row.site_moderation && row.site_rendered_at
    ? getRenderedSiteUrl(row.login_name, row.site_rendered_at)
    : placeholderScreenshotUrl();
}

/**
 * The apps' 둘러보기: the rows of /sites, discoverable sites with a screenshot
 * that operators have not hidden, newest update first; for a signed-in
 * account, without the sites it hid.
 *
 * With a search, the listed sites whose name or title contains it, and a site
 * named exactly that, listed or not (its address is public; a lookup is not
 * a listing), unless operators hid it or it was never published. The exact
 * match comes first.
 */
export async function showcasePage(page: number, userId?: string, search?: string) {
  const listed = (eb: ExpressionBuilder<DB, "users">) =>
    eb.and([
      eb("discoverable", "=", true),
      eb("site_rendered_at", "is not", null),
    ]);
  let query = db
    .selectFrom("users")
    .select([
      "login_name",
      "discoverable",
      "site_moderation",
      "site_rendered_at",
      "site_updated_at",
    ])
    .where("deleted_at", "is", null)
    .where("site_moderation", "is", null)
    .$if(!search, (q) => q.where(listed))
    .$if(Boolean(search), (q) => {
      const pattern = `%${search!.replace(/[\\%_]/g, "\\$&")}%`;
      return q
        .where((eb) =>
          eb.or([
            eb.and([
              listed(eb),
              eb.or([
                eb("login_name", "ilike", pattern),
                eb("site_title", "ilike", pattern),
              ]),
            ]),
            eb.and([
              eb(sql`lower(login_name)`, "=", search!.toLowerCase()),
              eb("site_updated_at", "is not", null),
            ]),
          ]),
        )
        .orderBy(sql`lower(login_name) = ${search!.toLowerCase()}`, "desc");
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
      screenshotUrl: cardScreenshotUrl(row),
      updatedAt: new Date(
        row.site_updated_at ?? row.site_rendered_at ?? 0,
      ).toISOString(),
    })),
    next: rows.length > SHOWCASE_PAGE_SIZE ? page + 1 : null,
  };
}
