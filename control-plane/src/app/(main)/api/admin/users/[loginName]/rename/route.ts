import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { RenameError, renameAccount } from "@/lib/account-rename";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { assertJsonContentType } from "@/lib/utils";

// Operators rename an account: { to: string } (lib/account-rename.ts).
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
  const from = decodeURIComponent((await context.params).loginName);
  const to = typeof body?.to === "string" ? body.to.trim() : body?.to;
  try {
    const result = await renameAccount(from, to);
    console.info(`${user.loginName} renamed ${from} to ${result.to}`);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof RenameError)
      return NextResponse.json(
        { success: false, message: error.message },
        { status: error.status },
      );
    console.error(`Renaming ${from} failed`, error);
    return NextResponse.json(
      { success: false, message: "이름을 바꾸지 못했습니다." },
      { status: 500 },
    );
  }
}
