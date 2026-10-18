import {
  cloudflareZone,
  createCustomRule,
  deleteCustomRule,
  listCustomRules,
  updateCustomRule,
} from "@/lib/cloudflare/firewall";
import { db } from "@/lib/database";
import { configureEdge } from "@/lib/edge/sync";
import {
  operatorAlertsConfigured,
  sendOperatorAlert,
} from "@/lib/operator-alerts";
import {
  getSiteBucketUrl,
  getSiteScreenshotKey,
  mediaOrigin,
} from "@/lib/site-urls";

// What operators do about a site (/admin/moderation), apart from the owner's
// own discoverable switch (users.site_moderation):
//
// - hidden: out of everything that lists or searches sites, the home page,
//   /sites and the apps' showcase and search. Still served.
// - suspended: hidden, and Naru stops serving it:
//   - its pages, custom domains and files: a WAF rule at Cloudflare blocks
//     its hosts and its paths in the site and media buckets (r2., media.),
//     which visitors reach without the edge Worker; its cached pages are
//     purged;
//   - its data: its object is told it has no database feature, so it hands
//     every request to the control plane, which refuses a suspended site
//     (site-data/service.ts);
//   - its notifications: what it sends is dropped, and the apps no longer
//     show its sites or notifications (app-api).
//
// Every change is kept in site_moderation_actions with who made it and why,
// and posted to the operators' Discord. The rule is applied at once and again
// by the site-request-limits job, so a Cloudflare error is retried.

export const MODERATION_LEVELS = ["hidden", "suspended"] as const;
export type ModerationLevel = (typeof MODERATION_LEVELS)[number];
export const MODERATION_LABELS: Record<ModerationLevel, string> = {
  hidden: "목록에서 숨김",
  suspended: "서비스 중지",
};

export const SUSPENDED_RULE_REF = "naru-suspended-sites";

/** Where Cloudflare blocks the suspended sites, or null when none is. */
export async function suspensionExpression() {
  const sites = await db
    .selectFrom("users")
    .select(["id", "login_name"])
    .where("site_moderation", "=", "suspended")
    .where("deleted_at", "is", null)
    .orderBy("login_name")
    .execute();
  if (!sites.length) return null;
  const domains = await db
    .selectFrom("custom_domains")
    .select("hostname")
    .where(
      "user_id",
      "in",
      sites.map((site) => site.id),
    )
    .orderBy("hostname")
    .execute();
  const quote = (text: string) => JSON.stringify(text);
  const hosts = [
    ...sites.map(
      (site) => `${site.login_name}.${process.env.NEXT_PUBLIC_DOMAIN}`,
    ),
    ...domains.map((domain) => domain.hostname.toLowerCase()),
  ];
  const under = (origin: string, prefixes: string[]) => {
    const host = new URL(origin).host;
    const paths = prefixes
      .map((prefix) => `starts_with(http.request.uri.path, ${quote(prefix)})`)
      .join(" or ");
    return `(http.host eq ${quote(host)} and (${paths}))`;
  };
  return [
    `(http.host in {${hosts.map(quote).join(" ")}})`,
    under(getSiteBucketUrl(""), [
      ...sites.map((site) => `/${site.login_name}/`),
      ...sites.map((site) => `/${getSiteScreenshotKey(site.login_name)}`),
    ]),
    under(
      mediaOrigin(),
      sites.map((site) => `/${site.id}/`),
    ),
  ].join(" or ");
}

/** Makes the managed rule block exactly the suspended sites. */
export async function applySuspensions() {
  if (!cloudflareZone()) return { applied: false };
  const expression = await suspensionExpression();
  const current = (await listCustomRules()).find(
    (rule) => rule.ref === SUSPENDED_RULE_REF,
  );
  const rule = {
    ref: SUSPENDED_RULE_REF,
    description:
      "Naru: sites suspended in /admin/moderation (managed by the control plane)",
    expression: expression ?? "",
    action: "block",
    enabled: true,
  };
  if (!expression) {
    if (current) await deleteCustomRule(current.id);
  } else if (!current) {
    await createCustomRule(rule);
  } else if (current.expression !== expression || !current.enabled) {
    await updateCustomRule(current.id, rule);
  }
  return { applied: true };
}

/**
 * Sets a site's moderation (null lifts it), records why, and applies it:
 * the Cloudflare rule, the edge cache and the site's object. Returns what
 * could not be applied, which the next job run retries.
 */
export async function setSiteModeration(
  site: { id: string; login: string },
  level: ModerationLevel | null,
  reason: string,
  operator: { id: string; loginName: string },
) {
  const before = await db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom("users")
      .select("site_moderation")
      .where("id", "=", site.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await tx
      .updateTable("users")
      .set({ site_moderation: level })
      .where("id", "=", site.id)
      .execute();
    await tx
      .insertInto("site_moderation_actions")
      .values({
        site_user_id: site.id,
        level,
        reason,
        operator_user_id: operator.id,
      })
      .execute();
    return row.site_moderation;
  });

  const failures: string[] = [];
  const attempt = async (what: string, task: () => Promise<unknown>) => {
    try {
      await task();
    } catch (error) {
      console.error(`[site-moderation] ${what} for ${site.login}:`, error);
      failures.push(what);
    }
  };
  if ((before === "suspended") !== (level === "suspended")) {
    await attempt("Cloudflare 규칙", applySuspensions);
    if (level === "suspended")
      await attempt("캐시 비우기", async () => {
        // Loaded here: it brings the S3 client, which the jsdom tests cannot load.
        const { purgeSite } = await import("@/lib/cache-purge");
        await purgeSite(site.login);
      });
    // Its object learns now, not at the next sync, whether it may answer.
    await attempt("사이트 데이터", () => configureEdge(site.login, site.id));
  }

  const what = level ? MODERATION_LABELS[level] : "조치 해제";
  if (operatorAlertsConfigured())
    await sendOperatorAlert({
      title: `사이트 관리: ${operator.loginName}님이 ${site.login} ${what}`,
      lines: [
        `사유: ${reason}`,
        ...(failures.length
          ? [`적용하지 못함 (다음 작업에서 다시 시도): ${failures.join(", ")}`]
          : []),
      ],
    }).catch((error) => console.error("Operator alert failed", error));
  return { failures };
}
