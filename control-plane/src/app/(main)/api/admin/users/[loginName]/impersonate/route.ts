import { NextRequest, NextResponse } from "next/server";
import {
  createImpersonationSession,
  setSessionCookie,
  validateRequest,
} from "@/lib/auth";
import { db } from "@/lib/database";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { assertSameOriginRequest } from "@/lib/utils";

// Operators view the control plane as another account: the request's session
// is swapped for one of that account that names the operator's own, for an
// hour or until /api/account/impersonation/end. Other operators' accounts are
// refused, so a view as an account never reaches /admin.
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ loginName: string }> },
) {
  const { user, session } = await validateRequest();
  if (!user) return NextResponse.json({ success: false }, { status: 401 });
  if (!PAYMENT_OPERATOR_USERS.has(user.loginName))
    return NextResponse.json({ success: false }, { status: 403 });
  try {
    assertSameOriginRequest(request);
  } catch {
    return NextResponse.json({ success: false }, { status: 400 });
  }
  const loginName = decodeURIComponent((await context.params).loginName);
  if (PAYMENT_OPERATOR_USERS.has(loginName))
    return NextResponse.json({ success: false }, { status: 403 });
  const target = await db
    .selectFrom("users")
    .select("id")
    .where("login_name", "=", loginName)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!target) return NextResponse.json({ success: false }, { status: 404 });
  const impersonation = await createImpersonationSession(target.id, session.id);
  await setSessionCookie(impersonation);
  console.info(`${user.loginName} started viewing as ${loginName}`);
  return NextResponse.json({ success: true });
}
