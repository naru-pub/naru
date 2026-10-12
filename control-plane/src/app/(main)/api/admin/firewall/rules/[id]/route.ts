import { NextRequest, NextResponse } from "next/server";
import { adminFailure, operatorJson } from "@/lib/admin-api";
import { CloudflareError } from "@/lib/cloudflare/firewall";
import {
  RULE_ID,
  changeRule,
  parseRule,
  removeRule,
} from "@/lib/cloudflare/firewall-admin";

type Context = { params: Promise<{ id: string }> };

// `{ enabled }` turns a rule on or off; a whole rule replaces it.
export async function PATCH(request: NextRequest, context: Context) {
  const operator = await operatorJson(request);
  if ("refused" in operator) return operator.refused;
  const { id } = await context.params;
  if (!RULE_ID.test(id)) return adminFailure("규칙을 찾지 못했어요.", 404);
  let change;
  if (Object.keys(operator.body).join() === "enabled") {
    if (typeof operator.body.enabled !== "boolean") return adminFailure("");
    change = { enabled: operator.body.enabled };
  } else {
    const rule = parseRule(operator.body);
    if (typeof rule === "string") return adminFailure(rule);
    change = rule;
  }
  try {
    await changeRule(id, change, operator.user.loginName);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof CloudflareError)
      return adminFailure(error.message, 409);
    throw error;
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  const operator = await operatorJson(request);
  if ("refused" in operator) return operator.refused;
  const { id } = await context.params;
  if (!RULE_ID.test(id)) return adminFailure("규칙을 찾지 못했어요.", 404);
  try {
    await removeRule(id, operator.user.loginName);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof CloudflareError)
      return adminFailure(error.message, 409);
    throw error;
  }
}
