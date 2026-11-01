import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/board/access";
import { boardErrorResponse, readJson } from "@/lib/board/errors";
import { saveSellerInterest } from "@/lib/board/seller-interest";

export async function PUT(request: NextRequest) {
  try {
    const body = await readJson(request);
    const user = await requireVerifiedUser();
    await saveSellerInterest(user, {
      description: body.description,
      priceRange: body.priceRange,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
