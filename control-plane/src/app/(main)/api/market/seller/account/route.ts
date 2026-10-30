import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/board/access";
import { boardErrorResponse, readJson } from "@/lib/board/errors";
import { changeSellerAccount } from "@/lib/market/sellers";

export async function PUT(request: NextRequest) {
  try {
    const body = await readJson(request);
    const user = await requireVerifiedUser();
    const seller = await changeSellerAccount(user, body);
    return NextResponse.json({ success: true, seller });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
