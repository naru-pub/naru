import { isIP } from "node:net";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { operatorAlertsConfigured, sendOperatorAlert } from "@/lib/operator-alerts";
import { DataError } from "@/lib/site-data/validation";
import { appSite, siteOrigins } from "./sites";
import type { AppUser } from "./tokens";

// What the apps offer against objectionable content (App Store guideline 1.2):
// hiding a site, and reporting a site or one notification it sent.
//
// A hidden site is left out of the account's showcase and inbox, and what it
// sends the account is dropped (delivery.ts), until the account shows it
// again. Hiding a starred site unstars it. Signed out, the apps hide sites on the device alone.
//
// A report is kept in app_reports. A signed-in report also goes to the
// operators' Discord and hides the site for the reporter; a signed-out one
// is only kept, limited by address (the gateway's X-Real-IP).

export const REPORT_REASONS = ["spam", "abuse", "sexual", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  spam: "스팸·광고",
  abuse: "괴롭힘·혐오",
  sexual: "선정적인 내용",
  illegal: "불법적인 내용",
  other: "기타",
};
/** Reports one reporter (an account, or an address signed out) may make an hour. */
export const REPORTS_PER_HOUR = 20;

async function siteNamed(name: string) {
  const site = await db
    .selectFrom("users")
    .select(["id", "login_name", "site_title"])
    .where("login_name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!site) throw new DataError(404, "사이트를 찾지 못했습니다.");
  return site;
}

export async function hideSite(user: AppUser, name: string) {
  const site = await siteNamed(name);
  await db
    .insertInto("app_hidden_sites")
    .values({ user_id: user.id, site_user_id: site.id })
    .onConflict((conflict) => conflict.columns(["user_id", "site_user_id"]).doNothing())
    .execute();
  await db
    .deleteFrom("site_stars")
    .where("user_id", "=", user.id)
    .where("site_user_id", "=", site.id)
    .execute();
}

export async function showSite(user: AppUser, name: string) {
  const site = await siteNamed(name);
  await db
    .deleteFrom("app_hidden_sites")
    .where("user_id", "=", user.id)
    .where("site_user_id", "=", site.id)
    .execute();
}

/** The sites the account hid, most recent first, so it can show them again. */
export async function listHiddenSites(user: AppUser) {
  const rows = await db
    .selectFrom("app_hidden_sites as h")
    .innerJoin("users as s", "s.id", "h.site_user_id")
    .select(["s.login_name", "s.site_title", "h.created_at"])
    .where("h.user_id", "=", user.id)
    .where("s.deleted_at", "is", null)
    .orderBy("h.created_at", "desc")
    .execute();
  const origins = await siteOrigins(rows.map((row) => row.login_name));
  return {
    sites: rows.map((row) => ({
      site: appSite(row, origins),
      hiddenAt: new Date(row.created_at).toISOString(),
    })),
  };
}

/**
 * The site ids an account does not see: the ones it hid, and the ones
 * operators suspended (site-moderation.ts), for leaving them out of its
 * showcase, inbox and sites.
 */
export function hiddenSiteIds(userId: string) {
  return db
    .selectFrom("app_hidden_sites")
    .select("site_user_id")
    .where("user_id", "=", userId)
    .union(
      db
        .selectFrom("users")
        .select("id as site_user_id")
        .where("site_moderation", "=", "suspended"),
    );
}

/** The operators' page for acting on a site, for the Discord alert. */
function adminModerationUrl(loginName: string) {
  const origin = `https://${process.env.NEXT_PUBLIC_DOMAIN || "naru.pub"}`;
  return new URL(`/admin/moderation/${encodeURIComponent(loginName)}`, origin).href;
}

export function requestIp(request: Request) {
  const ip = request.headers.get("x-real-ip")?.trim();
  return ip && isIP(ip) ? ip : null;
}

export async function report(
  reporter: { user: AppUser | null; ip: string | null },
  body: Record<string, unknown>,
) {
  const { site: name, notificationId, reason } = body;
  if (typeof name !== "string" || !REPORT_REASONS.includes(reason as ReportReason))
    throw new DataError(400, "신고 내용을 읽지 못했습니다.");
  if (
    notificationId !== undefined &&
    notificationId !== null &&
    (typeof notificationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(notificationId))
  )
    throw new DataError(400, "신고 내용을 읽지 못했습니다.");
  if (!reporter.user && !reporter.ip)
    throw new DataError(400, "신고를 받지 못했습니다. 로그인한 뒤 다시 시도해 주세요.");
  const site = await siteNamed(name);

  const recent = await db
    .selectFrom("app_reports")
    .select(sql<number>`count(*)::int`.as("count"))
    .where(
      reporter.user
        ? sql<boolean>`reporter_user_id = ${reporter.user.id}`
        : sql<boolean>`reporter_ip = ${reporter.ip}`,
    )
    .where("created_at", ">", new Date(Date.now() - 60 * 60 * 1000))
    .executeTakeFirstOrThrow();
  if (recent.count >= REPORTS_PER_HOUR)
    throw new DataError(429, "신고가 너무 많습니다. 잠시 뒤에 다시 시도해 주세요.");

  // Only a notification the reporter received names one; anything else is
  // reported as the site alone.
  const notification =
    reporter.user && typeof notificationId === "string"
      ? await db
          .selectFrom("app_notifications")
          .select(["id", "title", "body", "path"])
          .where("id", "=", notificationId)
          .where("user_id", "=", reporter.user.id)
          .where("site_user_id", "=", site.id)
          .executeTakeFirst()
      : undefined;

  await db
    .insertInto("app_reports")
    .values({
      reporter_user_id: reporter.user?.id ?? null,
      reporter_ip: reporter.user ? null : reporter.ip,
      site_user_id: site.id,
      notification_id: notification?.id ?? null,
      reason: reason as ReportReason,
    })
    .execute();
  if (!reporter.user) return { hidden: false };
  await hideSite(reporter.user, site.login_name);

  if (operatorAlertsConfigured())
    await sendOperatorAlert({
      title: `앱 신고: ${site.login_name}${site.site_title ? ` (${site.site_title})` : ""}`,
      lines: [
        `사유: ${REPORT_REASON_LABELS[reason as ReportReason]}`,
        `신고자: ${reporter.user.loginName}`,
        ...(notification
          ? [
              `알림: ${notification.title}`,
              ...(notification.body ? [notification.body.slice(0, 500)] : []),
              `경로: ${notification.path}`,
            ]
          : []),
        `조치: ${adminModerationUrl(site.login_name)}`,
      ],
    }).catch((error) => console.error("[app-report] Discord:", error));
  return { hidden: true };
}
