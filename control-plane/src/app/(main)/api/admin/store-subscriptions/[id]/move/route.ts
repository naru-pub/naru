import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { PAYMENT_OPERATOR_USERS } from "@/lib/payments/support";
import {
  moveStoreSubscription,
  StoreTransferError,
} from "@/lib/payments/store/ledger";
import { parseUuid } from "@/lib/uuid";
import { assertJsonContentType } from "@/lib/utils";

// Moves an App Store or Play subscription to another account
// (lib/payments/store/ledger, moveStoreSubscription). Operators only.
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
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
  const id = parseUuid((await context.params).id);
  const body = await request.json().catch(() => null);
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!id || !to || !reason || reason.length > 200)
    return NextResponse.json(
      {
        success: false,
        message: "옮길 계정과 사유(200자 이내)를 적어 주세요.",
      },
      { status: 400 },
    );
  try {
    const result = await moveStoreSubscription({
      subscriptionId: id,
      toLoginName: to,
      operator: { id: user.id, loginName: user.loginName },
      reason,
    });
    return NextResponse.json({ success: true, result });
  } catch (error) {
    if (error instanceof StoreTransferError)
      return NextResponse.json(
        { success: false, message: error.message },
        { status: error.status },
      );
    console.error("Store subscription move failed", error);
    return NextResponse.json(
      { success: false, message: "구독을 옮기지 못했습니다." },
      { status: 500 },
    );
  }
}
