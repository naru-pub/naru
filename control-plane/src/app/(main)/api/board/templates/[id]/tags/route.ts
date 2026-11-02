import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { setTemplateTags } from "@/lib/board/templates";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const templateId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireVerifiedUser();
    await setTemplateTags(user, templateId, body.tags);
    return NextResponse.json({ success: true });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
