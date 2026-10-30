import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/board/access";
import { boardErrorResponse, readJson } from "@/lib/board/errors";
import { registerAsSeller } from "@/lib/market/sellers";

// Registers the author at Toss as a payout seller. What they send goes to
// Toss; 나루 keeps the name, the bank and the account's last four digits.
export async function POST(request: NextRequest) {
  try {
    const body = await readJson(request);
    const user = await requireVerifiedUser();
    const seller = await registerAsSeller(user, body);
    return NextResponse.json({ success: true, seller });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
