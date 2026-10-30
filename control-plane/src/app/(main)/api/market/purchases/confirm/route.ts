import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse, readJson } from "@/lib/board/errors";
import { acceptTemplatePurchase } from "@/lib/market/purchases";

// Buying a template, step 2: Toss sent the buyer back with the payment
// they authenticated. Only its Absurd task approves it.
export async function POST(request: NextRequest) {
  try {
    const body = await readJson(request);
    const user = await requireUser();
    const accepted = await acceptTemplatePurchase(user, {
      orderId: body.orderId,
      paymentKey: body.paymentKey,
      amount: body.amount,
    });
    return NextResponse.json(
      { success: true, ...accepted },
      { status: accepted.done ? 200 : 202 },
    );
  } catch (error) {
    return boardErrorResponse(error);
  }
}
