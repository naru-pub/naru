import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { requestTemplateRefund } from "@/lib/market/purchases";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const purchaseId = parseId((await params).id);
    await readJson(request);
    const user = await requireUser();
    await requestTemplateRefund(user, purchaseId);
    return NextResponse.json(
      { success: true, message: "환불을 요청했어요. 카드 결제가 곧 취소돼요." },
      { status: 202 },
    );
  } catch (error) {
    return boardErrorResponse(error);
  }
}
