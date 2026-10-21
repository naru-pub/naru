import { NextRequest, NextResponse } from "next/server";
import { endImpersonation, validateRequest } from "@/lib/auth";
import { assertSameOriginRequest } from "@/lib/utils";

// Ends an operator's view as another account (api/admin/users/[loginName]/
// impersonate) and signs the operator back in as themselves.
export async function POST(request: NextRequest) {
  try {
    assertSameOriginRequest(request);
  } catch {
    return NextResponse.json({ success: false }, { status: 400 });
  }
  const { user, session } = await validateRequest();
  if (!session?.impersonatorSessionId)
    return NextResponse.json({ success: false }, { status: 400 });
  const operator = await endImpersonation(session);
  console.info(
    `${operator?.loginName ?? "an expired operator session"} stopped viewing as ${user.loginName}`,
  );
  return NextResponse.json({ success: true, signedIn: !!operator });
}
