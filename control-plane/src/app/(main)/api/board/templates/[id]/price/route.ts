import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { setTemplatePrice } from "@/lib/market/pricing";

// The template's price in won: 0 makes it free.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const templateId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireVerifiedUser();
    const price = await setTemplatePrice(user, templateId, body.price);
    return NextResponse.json({ success: true, price });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
