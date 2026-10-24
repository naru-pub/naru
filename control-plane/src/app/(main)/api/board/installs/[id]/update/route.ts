import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { applyUpdate } from "@/lib/board/updates";

// Updates the install, all or nothing; the plan is worked out again here.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const installId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireUser();
    const result = await applyUpdate(
      user,
      installId,
      body.versionId ? parseId(String(body.versionId)) : undefined,
    );
    return NextResponse.json({ success: true, result });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
