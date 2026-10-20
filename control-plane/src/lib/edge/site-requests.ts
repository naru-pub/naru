import { sql } from "kysely";
import { db } from "@/lib/database";
import { LOGIN_NAME_REGEX } from "@/lib/const";
import { getUserEntitlement } from "@/lib/entitlements";
import {
  cloudflareApi,
  cloudflareZone,
  createCustomRule,
  deleteCustomRule,
  listCustomRules,
  updateCustomRule,
  type CloudflareZone,
} from "@/lib/cloudflare/firewall";
import {
  operatorAlertsConfigured,
  sendOperatorAlert,
} from "@/lib/operator-alerts";

// Every request to a hosted site runs the edge Worker, and Cloudflare bills
// each one, whatever the Worker answers. So a site's requests are counted
// from Cloudflare's own analytics, which costs nothing, and a site that makes
// more than its monthly allowance is blocked by a WAF custom rule, which
// Cloudflare applies before the Worker runs, until the month (UTC) is over.
//
// Supporters' sites are never blocked, nor sites the operators exempt in
// /admin/firewall, where they can also block a site outright. The operators
// are told in Discord when a site passes half its allowance, when it passes
// all of it, and whenever the rule blocks or stops blocking a host.

const DEFAULT_ALLOWANCE = 10_000_000;
/** The share of the allowance at which the operators are first told. */
const WARN_SHARE = 0.5;
/** Identifies the one custom rule this module manages. */
export const SITE_LIMIT_RULE_REF = "naru-site-request-limit";
/** Daily counts are kept this long, for the operators to look back on. */
const KEEP_DAYS = 400;

export function monthlyAllowance() {
  return Number(process.env.SITE_MONTHLY_PAGE_REQUESTS) || DEFAULT_ALLOWANCE;
}

const day = (date: Date) => date.toISOString().slice(0, 10);
const monthOf = (now: Date) => `${day(now).slice(0, 7)}-01`;
const number = (value: number) => value.toLocaleString("en-US");

/**
 * Requests per hostname from `start` up to `end`, both ISO times within one
 * UTC day, as Cloudflare counts visitors' requests (its own beacon aside).
 */
async function countHostRequests(
  cf: CloudflareZone,
  start: string,
  end: string,
): Promise<Map<string, number>> {
  const data = await cloudflareApi<{
    viewer: {
      zones: {
        groups: {
          count: number;
          dimensions: { clientRequestHTTPHost: string };
        }[];
      }[];
    };
  }>(cf, "POST", "/graphql", {
    query: `query ($zone: String!, $start: Time!, $end: Time!) {
      viewer { zones(filter: { zoneTag: $zone }) {
        groups: httpRequestsAdaptiveGroups(
          limit: 10000
          filter: {
            datetime_geq: $start, datetime_lt: $end,
            requestSource: "eyeball", clientRequestPath_neq: "/cdn-cgi/rum"
          }
        ) { count dimensions { clientRequestHTTPHost } }
      } }
    }`,
    variables: { zone: cf.zone, start, end },
  });
  const counts = new Map<string, number>();
  for (const group of data?.viewer.zones[0]?.groups ?? []) {
    const host = group.dimensions.clientRequestHTTPHost.toLowerCase();
    counts.set(host, (counts.get(host) ?? 0) + group.count);
  }
  return counts;
}

/** Live sites' hostnames: `<login>.<domain>` and verified custom domains. */
async function siteHosts() {
  const domain = process.env.NEXT_PUBLIC_DOMAIN!;
  const users = await db
    .selectFrom("users")
    .select(["id", "login_name"])
    .where("deleted_at", "is", null)
    .execute();
  const domains = await db
    .selectFrom("custom_domains")
    .innerJoin("users", "users.id", "custom_domains.user_id")
    .select(["custom_domains.hostname", "users.id"])
    .where("custom_domains.verified_at", "is not", null)
    .where("users.deleted_at", "is", null)
    .execute();
  const userOf = new Map<string, string>();
  const hostsOf = new Map<string, string[]>();
  const add = (host: string, userId: string) => {
    userOf.set(host, userId);
    hostsOf.set(userId, [...(hostsOf.get(userId) ?? []), host]);
  };
  for (const user of users)
    if (LOGIN_NAME_REGEX.test(user.login_name))
      add(`${user.login_name}.${domain}`, user.id);
  for (const row of domains) add(row.hostname.toLowerCase(), row.id);
  return { userOf, hostsOf };
}

/** Counts the given UTC days (YYYY-MM-DD) into site_request_days. */
async function recordDays(cf: CloudflareZone, dates: string[], now: Date) {
  const { userOf } = await siteHosts();
  for (const date of dates) {
    const start = `${date}T00:00:00Z`;
    const next = new Date(Date.parse(start) + 86_400_000);
    const end = (next < now ? next : now).toISOString();
    const perUser = new Map<string, number>();
    for (const [host, count] of await countHostRequests(cf, start, end)) {
      const userId = userOf.get(host);
      if (userId) perUser.set(userId, (perUser.get(userId) ?? 0) + count);
    }
    if (perUser.size === 0) continue;
    await db
      .insertInto("site_request_days")
      .values(
        [...perUser].map(([userId, requests]) => ({
          user_id: userId,
          date,
          requests: String(requests),
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(["user_id", "date"])
          .doUpdateSet({ requests: (eb) => eb.ref("excluded.requests") }),
      )
      .execute();
  }
  await db
    .deleteFrom("site_request_days")
    .where("date", "<", sql<Date>`${day(now)}::date - ${KEEP_DAYS}::int`)
    .execute();
}

export type SiteRequestStatus = {
  userId: string;
  login: string;
  requests: number;
  override: "block" | "exempt" | null;
  overrideReason: string | null;
  supporter: boolean;
  blocked: boolean;
  warnedAt: Date | null;
  exceededAt: Date | null;
};

/**
 * This month's sites that passed half the allowance or have an override,
 * busiest first, each with whether the rule should block it.
 */
export async function siteRequestStatuses(
  now = new Date(),
): Promise<SiteRequestStatus[]> {
  const month = monthOf(now);
  const allowance = monthlyAllowance();
  const totals = await db
    .selectFrom("site_request_days")
    .select(["user_id", sql<string>`sum(requests)`.as("requests")])
    .where("date", ">=", sql<Date>`${month}::date`)
    .groupBy("user_id")
    .having(sql`sum(requests)`, ">=", allowance * WARN_SHARE)
    .execute();
  const overrides = await db
    .selectFrom("site_request_overrides")
    .select(["user_id", "mode", "reason"])
    .execute();
  const ids = [
    ...new Set([
      ...totals.map((row) => row.user_id),
      ...overrides.map((row) => row.user_id),
    ]),
  ];
  if (ids.length === 0) return [];
  const months = await db
    .selectFrom("site_request_months")
    .select(["user_id", "warned_at", "exceeded_at"])
    .where("month", "=", sql<Date>`${month}::date`)
    .execute();
  const users = await db
    .selectFrom("users")
    .select(["id", "login_name"])
    .where("deleted_at", "is", null)
    .where("id", "in", ids)
    .execute();
  const requestsOf = new Map(
    totals.map((row) => [row.user_id, Number(row.requests)]),
  );
  const overrideOf = new Map(overrides.map((row) => [row.user_id, row]));
  const monthOfUser = new Map(months.map((row) => [row.user_id, row]));
  const statuses: SiteRequestStatus[] = [];
  for (const user of users) {
    const requests = requestsOf.get(user.id) ?? 0;
    const override = overrideOf.get(user.id);
    const supporter = (await getUserEntitlement(user.id)).hasPaidFeatures;
    const blocked =
      override?.mode === "block" ||
      (requests >= allowance && !supporter && override?.mode !== "exempt");
    statuses.push({
      userId: user.id,
      login: user.login_name,
      requests,
      override: override?.mode ?? null,
      overrideReason: override?.reason ?? null,
      supporter,
      blocked,
      warnedAt: monthOfUser.get(user.id)?.warned_at ?? null,
      exceededAt: monthOfUser.get(user.id)?.exceeded_at ?? null,
    });
  }
  return statuses.sort((a, b) => b.requests - a.requests);
}

/** The hostnames a rule's `http.host in {...}` expression names. */
function ruleHosts(expression: string | undefined) {
  return new Set(
    [...(expression?.matchAll(/"([^"]+)"/g) ?? [])].map((match) => match[1]),
  );
}

/**
 * Makes the managed rule block exactly the sites due a block, or removes it
 * when none is; returns what changed, for the operators.
 */
async function applyBlocks(statuses: SiteRequestStatus[]) {
  const { hostsOf } = await siteHosts();
  const hosts = statuses
    .filter((status) => status.blocked)
    .flatMap((status) => hostsOf.get(status.userId) ?? [])
    .sort();
  const current = (await listCustomRules()).find(
    (rule) => rule.ref === SITE_LIMIT_RULE_REF,
  );
  const before = ruleHosts(current?.expression);
  const rule = {
    ref: SITE_LIMIT_RULE_REF,
    description:
      "Naru: sites past their monthly request allowance, or blocked in /admin/firewall (managed by the control plane)",
    expression: `http.host in {${hosts.map((host) => JSON.stringify(host)).join(" ")}}`,
    action: "block",
    enabled: true,
  };
  if (hosts.length === 0) {
    if (current) await deleteCustomRule(current.id);
  } else if (!current) {
    await createCustomRule(rule);
  } else if (current.expression !== rule.expression || !current.enabled) {
    await updateCustomRule(current.id, rule);
  }
  return {
    blocked: hosts.filter((host) => !before.has(host)),
    lifted: [...before].filter((host) => !hosts.includes(host)),
  };
}

function changeLines(changes: { blocked: string[]; lifted: string[] }) {
  return [
    ...(changes.blocked.length ? [`차단: ${changes.blocked.join(", ")}`] : []),
    ...(changes.lifted.length
      ? [`차단 해제: ${changes.lifted.join(", ")}`]
      : []),
  ];
}

async function alert(title: string, lines: string[]) {
  if (operatorAlertsConfigured()) await sendOperatorAlert({ title, lines });
}

/**
 * Counts yesterday and today, then makes the rule block the sites due a
 * block this month and tells the operators what passed a threshold or
 * changed. Run by the site-request-limits job.
 */
export async function limitSiteRequests(now = new Date()) {
  const cf = cloudflareZone();
  if (!cf) return { counted: false, blocked: 0 };
  await recordDays(
    cf,
    [day(new Date(now.getTime() - 86_400_000)), day(now)],
    now,
  );

  const month = monthOf(now);
  const allowance = monthlyAllowance();
  const statuses = await siteRequestStatuses(now);
  const lines: string[] = [];
  const marks: { userId: string; exceeded: boolean }[] = [];
  for (const site of statuses) {
    const usage = `${number(site.requests)} / ${number(allowance)} (${Math.round((site.requests / allowance) * 100)}%)`;
    if (site.requests >= allowance && !site.exceededAt) {
      const spared =
        site.override === "exempt"
          ? ", 예외라 차단하지 않음"
          : site.supporter
            ? ", 후원자라 차단하지 않음"
            : "";
      lines.push(`${site.login}: 이번 달 요청 한도 넘음${spared} — ${usage}`);
      marks.push({ userId: site.userId, exceeded: true });
    } else if (site.requests >= allowance * WARN_SHARE && !site.warnedAt) {
      lines.push(`${site.login}: 이번 달 요청 절반 넘음 — ${usage}`);
      marks.push({ userId: site.userId, exceeded: false });
    }
  }
  lines.push(...changeLines(await applyBlocks(statuses)));
  if (lines.length > 0)
    await alert(`사이트 요청 한도 (${month.slice(0, 7)})`, lines);

  for (const mark of marks)
    await db
      .insertInto("site_request_months")
      .values({
        user_id: mark.userId,
        month,
        warned_at: sql<Date>`now()`,
        exceeded_at: mark.exceeded ? sql<Date>`now()` : null,
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "month"]).doUpdateSet({
          warned_at: sql<Date>`coalesce(site_request_months.warned_at, now())`,
          ...(mark.exceeded
            ? {
                exceeded_at: sql<Date>`coalesce(site_request_months.exceeded_at, now())`,
              }
            : {}),
        }),
      )
      .execute();
  return {
    counted: true,
    blocked: statuses.filter((status) => status.blocked).length,
  };
}

/**
 * Sets or clears the operators' word on a site, applies it to the rule at
 * once and tells the other operators.
 */
export async function setSiteRequestOverride(
  site: { userId: string; login: string },
  override: { mode: "block" | "exempt"; reason: string } | null,
  operator: { id: string; loginName: string },
  now = new Date(),
) {
  if (override)
    await db
      .insertInto("site_request_overrides")
      .values({
        user_id: site.userId,
        mode: override.mode,
        reason: override.reason,
        created_by: operator.id,
      })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          mode: override.mode,
          reason: override.reason,
          created_by: operator.id,
          created_at: sql<Date>`now()`,
        }),
      )
      .execute();
  else
    await db
      .deleteFrom("site_request_overrides")
      .where("user_id", "=", site.userId)
      .execute();
  const changes = await applyBlocks(await siteRequestStatuses(now));
  const what = override
    ? `${override.mode === "block" ? "항상 차단" : "차단 예외"} (${override.reason})`
    : "지정 해제";
  // Done either way: a Discord outage does not undo an operator's change.
  await alert(
    `사이트 요청 한도: ${operator.loginName}님이 ${site.login} ${what}`,
    changeLines(changes),
  ).catch((error) => console.error("Operator alert failed", error));
  return changes;
}
