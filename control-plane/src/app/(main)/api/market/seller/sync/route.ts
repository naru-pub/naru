import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { BoardError, boardErrorResponse, readJson } from "@/lib/board/errors";
import { findSeller, summarize, syncSeller } from "@/lib/market/sellers";

// Asks Toss for the seller's status now: after verifying their identity,
// the seller need not wait for the webhook.
export async function POST(request: NextRequest) {
  try {
    await readJson(request);
    const user = await requireUser();
    const seller = await findSeller(user.id);
    if (!seller?.toss_seller_id)
      throw new BoardError(404, "판매자로 등록하지 않았어요.");
    await syncSeller(seller.toss_seller_id);
    const synced = await findSeller(user.id);
    return NextResponse.json({ success: true, seller: summarize(synced!) });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
