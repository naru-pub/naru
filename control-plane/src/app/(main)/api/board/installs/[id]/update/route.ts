import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { progressResponse, wantsProgress } from "@/lib/board/progress-stream";
import { applyUpdate, type UpdateProgress } from "@/lib/board/updates";

// Updates the install, all or nothing; the plan is worked out again here.
// A page may follow its progress (progress-stream.ts).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const installId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireUser();
    const versionId = body.versionId
      ? parseId(String(body.versionId))
      : undefined;
    if (wantsProgress(request))
      return progressResponse((report: (progress: UpdateProgress) => void) =>
        applyUpdate(user, installId, versionId, report),
      );
    const result = await applyUpdate(user, installId, versionId);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
