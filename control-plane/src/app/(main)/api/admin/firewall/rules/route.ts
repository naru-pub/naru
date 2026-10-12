import { NextRequest, NextResponse } from "next/server";
import { adminFailure, operatorJson } from "@/lib/admin-api";
import { CloudflareError } from "@/lib/cloudflare/firewall";
import { addRule, parseRule } from "@/lib/cloudflare/firewall-admin";

export async function POST(request: NextRequest) {
  const operator = await operatorJson(request);
  if ("refused" in operator) return operator.refused;
  const rule = parseRule(operator.body);
  if (typeof rule === "string") return adminFailure(rule);
  try {
    await addRule(rule, operator.user.loginName);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof CloudflareError)
      return adminFailure(error.message, 502);
    throw error;
  }
}
