import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { assertJsonContentType } from "@/lib/utils";

// Operators give an account the supporter plan for free, or take it back:
// { comp: boolean }. A comp is never charged (the renewal cron skips it), so a
// plan the account pays for resumes charging from its next billing date once
// the comp is taken back.
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ loginName: string }> },
) {
  const { user } = await validateRequest();
  if (!user) return NextResponse.json({ success: false }, { status: 401 });
  if (!PAYMENT_OPERATOR_USERS.has(user.loginName))
    return NextResponse.json({ success: false }, { status: 403 });
  try {
    assertJsonContentType(request);
  } catch {
    return NextResponse.json({ success: false }, { status: 400 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false }, { status: 400 });
  }
  if (typeof body?.comp !== "boolean")
    return NextResponse.json({ success: false }, { status: 400 });
  const loginName = decodeURIComponent((await context.params).loginName);
  const updated = await db
    .updateTable("users")
    .set({ supporter_comp: body.comp })
    .where("login_name", "=", loginName)
    .where("deleted_at", "is", null)
    .returning("supporter_comp")
    .executeTakeFirst();
  if (!updated) return NextResponse.json({ success: false }, { status: 404 });
  console.info(
    `${user.loginName} set supporter_comp=${body.comp} for ${loginName}`,
  );
  return NextResponse.json({ success: true, comp: updated.supporter_comp });
}
