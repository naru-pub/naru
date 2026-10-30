import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse, parseId } from "@/lib/board/errors";
import { getPurchase } from "@/lib/market/purchases";

// Where a purchase stands, for the page waiting on its approval.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const purchaseId = parseId((await params).id);
    const user = await requireUser();
    const purchase = await getPurchase(user, purchaseId);
    return NextResponse.json({ success: true, purchase });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
