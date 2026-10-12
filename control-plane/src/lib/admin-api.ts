import { NextRequest, NextResponse } from "next/server";
import { validateRequest, type User } from "@/lib/auth";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import { assertJsonContentType } from "@/lib/utils";

/**
 * The operator making an /api/admin request with a JSON body, and the body;
 * or the response refusing it.
 */
export async function operatorJson(
  request: NextRequest,
): Promise<
  { user: User; body: Record<string, unknown> } | { refused: NextResponse }
> {
  const refuse = (status: number) => ({
    refused: NextResponse.json({ success: false }, { status }),
  });
  const { user } = await validateRequest();
  if (!user) return refuse(401);
  if (!PAYMENT_OPERATOR_USERS.has(user.loginName)) return refuse(403);
  try {
    assertJsonContentType(request);
    const body = await request.json();
    if (typeof body !== "object" || body === null) return refuse(400);
    return { user, body };
  } catch {
    return refuse(400);
  }
}

/** A failure the operator should read, as /admin buttons show it. */
export function adminFailure(message: string, status = 400) {
  return NextResponse.json({ success: false, message }, { status });
}
