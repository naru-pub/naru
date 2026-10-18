import { NextRequest, NextResponse } from "next/server";
import { adminFailure, operatorJson } from "@/lib/admin-api";
import { LOGIN_NAME_REGEX } from "@/lib/const";
import { db } from "@/lib/database";
import {
  MODERATION_LEVELS,
  setSiteModeration,
  type ModerationLevel,
} from "@/lib/site-moderation";

// `{ level: "hidden" | "suspended" | null, reason }` sets what operators do
// about a site; null lifts it. See lib/site-moderation.ts.
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ login: string }> },
) {
  const operator = await operatorJson(request);
  if ("refused" in operator) return operator.refused;
  const login = decodeURIComponent((await context.params).login).toLowerCase();
  const site =
    LOGIN_NAME_REGEX.test(login) &&
    (await db
      .selectFrom("users")
      .select(["id", "login_name"])
      .where("login_name", "=", login)
      .where("deleted_at", "is", null)
      .executeTakeFirst());
  if (!site) return adminFailure("사이트를 찾지 못했어요.", 404);
  const { level, reason } = operator.body;
  if (level !== null && !MODERATION_LEVELS.includes(level as ModerationLevel))
    return adminFailure("목록에서 숨김, 서비스 중지, 해제 중에 고르세요.");
  if (typeof reason !== "string" || !reason.trim() || reason.length > 500)
    return adminFailure("사유를 500자 이내로 적어 주세요.");
  const { failures } = await setSiteModeration(
    { id: site.id, login: site.login_name },
    level as ModerationLevel | null,
    reason.trim(),
    operator.user,
  );
  return NextResponse.json({ success: true, failures });
}
