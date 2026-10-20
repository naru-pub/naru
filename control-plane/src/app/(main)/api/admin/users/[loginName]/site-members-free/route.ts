import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { assertJsonContentType } from "@/lib/utils";

// Operators require a supporter plan of a site's members, or lift that
// requirement: { free: boolean }. Members already signed in are
// checked on their next request either way.
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
  if (typeof body?.free !== "boolean")
    return NextResponse.json({ success: false }, { status: 400 });
  const loginName = decodeURIComponent((await context.params).loginName);
  const updated = await db
    .updateTable("users")
    .set({ site_members_free: body.free })
    .where("login_name", "=", loginName)
    .where("deleted_at", "is", null)
    .returning("site_members_free")
    .executeTakeFirst();
  if (!updated) return NextResponse.json({ success: false }, { status: 404 });
  console.info(
    `${user.loginName} set site_members_free=${body.free} for ${loginName}`,
  );
  return NextResponse.json({
    success: true,
    free: updated.site_members_free,
  });
}
