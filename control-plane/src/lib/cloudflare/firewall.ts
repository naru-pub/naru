// The naru.pub zone's WAF custom rules, which Cloudflare applies to every
// request before the edge Worker runs: a request a rule blocks is never
// billed as a Worker request. The free plan allows five rules.
//
// Needs CLOUDFLARE_ZONE_ID and a CLOUDFLARE_USER_API_TOKEN that may read the
// zone's analytics (Zone > Analytics: Read) and edit its custom rules
// (Zone > Zone WAF: Edit).

const API = "https://api.cloudflare.com/client/v4";

export const RULE_ACTION_LABELS: Record<string, string> = {
  block: "차단",
  managed_challenge: "관리형 챌린지",
  js_challenge: "JS 챌린지",
};
export const RULE_ACTIONS = Object.keys(RULE_ACTION_LABELS);
export type RuleAction = string;

export type FirewallRule = {
  id: string;
  ref?: string;
  description?: string;
  expression: string;
  action: string;
  enabled: boolean;
  last_updated?: string;
};

export type RuleInput = {
  ref?: string;
  description: string;
  expression: string;
  action: RuleAction;
  enabled: boolean;
};

export class CloudflareError extends Error {}

export function cloudflareZone() {
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  const token = process.env.CLOUDFLARE_USER_API_TOKEN;
  return zone && token ? { zone, token } : null;
}

export type CloudflareZone = NonNullable<ReturnType<typeof cloudflareZone>>;

function zoneOrThrow() {
  const cf = cloudflareZone();
  if (!cf) throw new CloudflareError("Cloudflare is not configured");
  return cf;
}

/** One API call; null when Cloudflare answers 404. */
export async function cloudflareApi<T>(
  cf: CloudflareZone,
  method: string,
  path: string,
  body?: unknown,
): Promise<T | null> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cf.token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  const json = (await response.json()) as {
    success?: boolean;
    result?: T;
    data?: T;
    errors?: { message: string }[] | null;
  };
  if (!response.ok || json.success === false || json.errors?.length)
    throw new CloudflareError(
      `Cloudflare ${method} ${path} answered ${response.status}: ${(json.errors ?? []).map((error) => error.message).join("; ")}`.slice(
        0,
        1000,
      ),
    );
  return (json.result ?? json.data) as T;
}

const entrypoint = (cf: CloudflareZone) =>
  `/zones/${cf.zone}/rulesets/phases/http_request_firewall_custom/entrypoint`;

async function customRuleset(cf: CloudflareZone) {
  return cloudflareApi<{ id: string; rules?: FirewallRule[] }>(
    cf,
    "GET",
    entrypoint(cf),
  );
}

/** The zone's custom rules, in the order Cloudflare applies them. */
export async function listCustomRules(): Promise<FirewallRule[]> {
  return (await customRuleset(zoneOrThrow()))?.rules ?? [];
}

/** Adds a rule after the others, making the zone's ruleset if it has none. */
export async function createCustomRule(rule: RuleInput) {
  const cf = zoneOrThrow();
  const ruleset = await customRuleset(cf);
  if (!ruleset)
    await cloudflareApi(cf, "PUT", entrypoint(cf), { rules: [rule] });
  else
    await cloudflareApi(
      cf,
      "POST",
      `/zones/${cf.zone}/rulesets/${ruleset.id}/rules`,
      rule,
    );
}

/** Replaces a rule's definition; Cloudflare takes the whole rule. */
export async function updateCustomRule(id: string, rule: RuleInput) {
  const cf = zoneOrThrow();
  const ruleset = await customRuleset(cf);
  if (!ruleset) throw new CloudflareError("The zone has no custom rules");
  await cloudflareApi(
    cf,
    "PATCH",
    `/zones/${cf.zone}/rulesets/${ruleset.id}/rules/${id}`,
    rule,
  );
}

export async function deleteCustomRule(id: string) {
  const cf = zoneOrThrow();
  const ruleset = await customRuleset(cf);
  if (!ruleset) return;
  await cloudflareApi(
    cf,
    "DELETE",
    `/zones/${cf.zone}/rulesets/${ruleset.id}/rules/${id}`,
  );
}

/** The rule input of a listed rule, to change one field of it. */
export function ruleInput(rule: FirewallRule): RuleInput {
  return {
    ...(rule.ref ? { ref: rule.ref } : {}),
    description: rule.description ?? "",
    expression: rule.expression,
    action: rule.action,
    enabled: rule.enabled,
  };
}
