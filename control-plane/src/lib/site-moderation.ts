import {
  cloudflareZone,
  createCustomRule,
  listCustomRules,
  updateCustomRule,
} from "@/lib/cloudflare/firewall";
import { db } from "@/lib/database";
import { pushEdgeDomains } from "@/lib/edge/domains";
import { configureEdge } from "@/lib/edge/sync";
import {
  operatorAlertsConfigured,
  sendOperatorAlert,
} from "@/lib/operator-alerts";
import { QUARANTINE_PREFIX, enqueueQuarantine } from "@/lib/site-suspension";
import { getSiteBucketUrl, mediaOrigin } from "@/lib/site-urls";

// What operators do about a site (/admin/moderation), apart from the owner's
// own discoverable switch (users.site_moderation):
//
// - hidden: out of everything that lists or searches sites, the home page,
//   /sites and the apps' showcase and search. Still served.
// - suspended: hidden, and Naru stops serving it, however many sites are:
//   - its pages and custom domains: the edge Worker refuses it on every host
//     (the domain table lists it, edge/domains.ts), and its cached pages are
//     purged;
//   - its files in the buckets' public hosts, which visitors reach without
//     the Worker: a durable task moves them under _suspended/
//     (site-quarantine.ts), which one fixed Cloudflare rule blocks, and back
//     when the suspension is lifted; its owner cannot write meanwhile
//     (site-suspension.ts);
//   - its data: its object is told it has no database feature, so it hands
//     every request to the control plane, which refuses a suspended site
//     (site-data/service.ts);
//   - its notifications: what it sends is dropped, and the apps no longer
//     show its sites or notifications (app-api).
//
// Every change is kept in site_moderation_actions with who made it and why,
// and posted to the operators' Discord. What fails to apply at once is
// retried: the edge table by the edge-sync job, the rule by the
// site-request-limits job, the file move by its task.

export const MODERATION_LEVELS = ["hidden", "suspended"] as const;
export type ModerationLevel = (typeof MODERATION_LEVELS)[number];
export const MODERATION_LABELS: Record<ModerationLevel, string> = {
  hidden: "목록에서 숨김",
  suspended: "서비스 중지",
};

export const SUSPENDED_RULE_REF = "naru-suspended-sites";

/** What the rule blocks: quarantined files on the buckets' public hosts. */
export function quarantineExpression() {
  const hosts = [
    new URL(getSiteBucketUrl("")).host,
    new URL(mediaOrigin()).host,
  ];
  return `(http.host in {${hosts.map((host) => JSON.stringify(host)).join(" ")}} and starts_with(http.request.uri.path, ${JSON.stringify(`/${QUARANTINE_PREFIX}`)}))`;
}

/** Makes sure the one fixed rule blocking quarantined files is in place. */
export async function applySuspensions() {
  if (!cloudflareZone()) return { applied: false };
  const expression = quarantineExpression();
  const current = (await listCustomRules()).find(
    (rule) => rule.ref === SUSPENDED_RULE_REF,
  );
  const rule = {
    ref: SUSPENDED_RULE_REF,
    description:
      "Naru: files of sites suspended in /admin/moderation, moved under /_suspended/ (managed by the control plane)",
    expression,
    action: "block",
    enabled: true,
  };
  if (!current) await createCustomRule(rule);
  else if (current.expression !== expression || !current.enabled)
    await updateCustomRule(current.id, rule);
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
    const action = await tx
      .insertInto("site_moderation_actions")
      .values({
        site_user_id: site.id,
        level,
        reason,
        operator_user_id: operator.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    // The files move with the change, or not at all.
    if ((row.site_moderation === "suspended") !== (level === "suspended"))
      await enqueueQuarantine(tx, {
        userId: site.id,
        login: site.login,
        direction: level === "suspended" ? "in" : "out",
        actionId: action.id,
      });
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
    // The edge refuses it, or serves it again, now rather than at the next sync.
    await attempt("엣지 차단 목록", pushEdgeDomains);
    if (level === "suspended")
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
