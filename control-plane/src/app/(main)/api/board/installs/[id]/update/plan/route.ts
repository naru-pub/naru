import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { planUpdate } from "@/lib/board/updates";

// What updating would change, without writing anything.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const installId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireUser();
    const plan = await planUpdate(
      user,
      installId,
      body.versionId ? parseId(String(body.versionId)) : undefined,
    );
    return NextResponse.json({ success: true, plan });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
