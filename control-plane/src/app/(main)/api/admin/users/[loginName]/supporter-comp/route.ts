import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { AccountBusyError, withAccountLock } from "@/lib/payments/account-lock";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { setSupporterComp } from "@/lib/payments/subscriptions";
import { assertJsonContentType } from "@/lib/utils";

// Operators give an account the supporter plan for free, or take it back:
// { comp: boolean }. A comp is never charged (the renewal cron skips it), so a
// plan the account pays for resumes charging once the comp is taken back: on
// its next billing date, or after a renewal notice when that is too close or
// has passed (setSupporterComp).
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
  const comp: boolean = body.comp;
  const loginName = decodeURIComponent((await context.params).loginName);
  const target = await db
    .selectFrom("users")
    .select("id")
    .where("login_name", "=", loginName)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!target) return NextResponse.json({ success: false }, { status: 404 });
  let updated;
  try {
    updated = await withAccountLock(target.id, { waitMs: 10_000 }, () =>
      setSupporterComp(target.id, comp),
    );
  } catch (error) {
    if (error instanceof AccountBusyError)
      return NextResponse.json({ success: false }, { status: 409 });
    throw error;
  }
  if (!updated) return NextResponse.json({ success: false }, { status: 404 });
  console.info(`${user.loginName} set supporter_comp=${comp} for ${loginName}`);
  return NextResponse.json({ success: true, comp });
}
