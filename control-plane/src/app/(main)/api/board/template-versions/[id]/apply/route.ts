import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { progressResponse, wantsProgress } from "@/lib/board/progress-stream";
import { applyTemplate, type ApplyProgress } from "@/lib/board/templates";

// Applying writes only to the person's own site, so it needs a login but not
// a verified email.
//
// A page that asks for application/x-ndjson gets the application's progress
// as it goes, one JSON line each, and then a "done" line with the result or
// the message: a template of a few hundred files takes a while. Anything
// else gets the result as one JSON answer.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const versionId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireUser();
    const input = {
      targetPath: body.targetPath,
      backup: body.backup,
      createCollections: body.createCollections,
      notify: body.notify,
      replace: body.replace,
      resetDatabase: body.resetDatabase,
    };
    if (!wantsProgress(request)) {
      const result = await applyTemplate(user, versionId, input);
      return NextResponse.json({ success: true, result });
    }
    return progressResponse((report: (progress: ApplyProgress) => void) =>
      applyTemplate(user, versionId, { ...input, onProgress: report }),
    );
  } catch (error) {
    return boardErrorResponse(error);
  }
}
