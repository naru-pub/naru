import { SITE_LIMIT_RULE_REF } from "@/lib/edge/site-requests";
import {
  operatorAlertsConfigured,
  sendOperatorAlert,
} from "@/lib/operator-alerts";
import {
  CloudflareError,
  RULE_ACTIONS,
  createCustomRule,
  deleteCustomRule,
  listCustomRules,
  ruleInput,
  updateCustomRule,
  type RuleAction,
  type RuleInput,
} from "./firewall";

// The custom rules as operators change them from /admin/firewall. The rule
// the site request limits keep (lib/edge/site-requests.ts) is theirs alone:
// it is changed by blocking or exempting sites, never by hand. Every change
// is told to the operators in Discord.

const MAX_DESCRIPTION = 500;
// Cloudflare's limit on a rule expression.
const MAX_EXPRESSION = 4096;

export const RULE_ID = /^[0-9a-f]{32}$/;

/** A rule from an operator's form, or what is wrong with it. */
export function parseRule(
  body: Record<string, unknown>,
): Omit<RuleInput, "enabled"> | string {
  const { description, expression, action } = body;
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION)
    return `설명은 ${MAX_DESCRIPTION}자 이내로 적어 주세요.`;
  if (
    typeof expression !== "string" ||
    !expression.trim() ||
    expression.length > MAX_EXPRESSION
  )
    return `조건식을 ${MAX_EXPRESSION}자 이내로 적어 주세요.`;
  if (typeof action !== "string" || !RULE_ACTIONS.includes(action))
    return "동작을 고르세요.";
  return {
    description: description.trim(),
    expression: expression.trim(),
    action: action as RuleAction,
  };
}

async function tell(title: string, lines: string[]) {
  if (!operatorAlertsConfigured()) return;
  // Done either way: a Discord outage does not undo an operator's change.
  await sendOperatorAlert({ title, lines }).catch((error) =>
    console.error("Operator alert failed", error),
  );
}

async function editable(id: string) {
  const rule = (await listCustomRules()).find((rule) => rule.id === id);
  if (!rule) throw new CloudflareError("규칙을 찾지 못했어요.");
  if (rule.ref === SITE_LIMIT_RULE_REF)
    throw new CloudflareError(
      "사이트 요청 한도 규칙은 사이트를 차단하거나 예외로 두어 바꿔요.",
    );
  return rule;
}

const summary = (rule: { action: string; expression: string }) =>
  `${rule.action}: ${rule.expression}`;

export async function addRule(
  rule: Omit<RuleInput, "enabled">,
  operator: string,
) {
  await createCustomRule({ ...rule, enabled: true });
  await tell(`방화벽 규칙 추가: ${operator}님 — ${rule.description}`, [
    summary(rule),
  ]);
}

export async function changeRule(
  id: string,
  change: Partial<RuleInput>,
  operator: string,
) {
  const before = await editable(id);
  const after = { ...ruleInput(before), ...change };
  await updateCustomRule(id, after);
  const what =
    change.enabled === undefined ? "수정" : change.enabled ? "켬" : "끔";
  await tell(
    `방화벽 규칙 ${what}: ${operator}님 — ${after.description}`,
    change.expression !== undefined || change.action !== undefined
      ? [`이전 ${summary(before)}`, `이후 ${summary(after)}`]
      : [],
  );
}

export async function removeRule(id: string, operator: string) {
  const rule = await editable(id);
  await deleteCustomRule(id);
  await tell(`방화벽 규칙 삭제: ${operator}님 — ${rule.description ?? ""}`, [
    summary(rule),
  ]);
}
