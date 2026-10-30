import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { prepareTemplatePurchase } from "@/lib/market/purchases";

// Buying a template, step 1: the order the payment window is opened for,
// at the price 나루 records.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const templateId = parseId((await params).id);
    // JSON only, like every payment route: a form posted from a site on a
    // subdomain carries the session cookie but cannot set the type.
    await readJson(request);
    const user = await requireUser();
    const order = await prepareTemplatePurchase(user, templateId);
    return NextResponse.json({ success: true, ...order });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
