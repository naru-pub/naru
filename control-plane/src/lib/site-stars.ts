import { db } from "@/lib/database";
import { DataError } from "@/lib/site-data/validation";

// Stars: sites an account keeps at hand, whether or not they are
// discoverable. The Naru app lists them (app-api/stars.ts).

async function siteId(name: string) {
  const site = await db
    .selectFrom("users")
    .select("id")
    .where("login_name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!site) throw new DataError(404, "사이트를 찾지 못했습니다.");
  return site.id;
}

export async function starSite(userId: string, name: string) {
  await db
    .insertInto("site_stars")
    .values({ user_id: userId, site_user_id: await siteId(name) })
    .onConflict((conflict) => conflict.columns(["user_id", "site_user_id"]).doNothing())
    .execute();
}

export async function unstarSite(userId: string, name: string) {
  await db
    .deleteFrom("site_stars")
    .where("user_id", "=", userId)
    .where("site_user_id", "=", await siteId(name))
    .execute();
}
