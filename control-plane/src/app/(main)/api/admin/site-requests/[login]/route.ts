import { NextRequest, NextResponse } from "next/server";
import { adminFailure, operatorJson } from "@/lib/admin-api";
import { db } from "@/lib/database";
import { CloudflareError } from "@/lib/cloudflare/firewall";
import { setSiteRequestOverride } from "@/lib/edge/site-requests";
import { LOGIN_NAME_REGEX } from "@/lib/const";

// `{ mode: "block" | "exempt", reason }` sets the operators' word on a site's
// requests; `{ mode: null }` clears it, leaving the site to its allowance.
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ login: string }> },
) {
  const operator = await operatorJson(request);
  if ("refused" in operator) return operator.refused;
  const login = (await context.params).login.toLowerCase();
  const site =
    LOGIN_NAME_REGEX.test(login) &&
    (await db
      .selectFrom("users")
      .select(["id", "login_name"])
      .where("login_name", "=", login)
      .where("deleted_at", "is", null)
      .executeTakeFirst());
  if (!site) return adminFailure("사이트를 찾지 못했어요.", 404);
  const { mode, reason } = operator.body;
  if (mode !== null && mode !== "block" && mode !== "exempt")
    return adminFailure("차단, 예외, 해제 중에 고르세요.");
  if (
    mode &&
    (typeof reason !== "string" || !reason.trim() || reason.length > 200)
  )
    return adminFailure("사유를 200자 이내로 적어 주세요.");
  try {
    const changes = await setSiteRequestOverride(
      { userId: site.id, login: site.login_name },
      mode ? { mode, reason: (reason as string).trim() } : null,
      operator.user,
    );
    return NextResponse.json({ success: true, changes });
  } catch (error) {
    if (error instanceof CloudflareError)
      return adminFailure(error.message, 502);
    throw error;
  }
}
