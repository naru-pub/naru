import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { applyTemplate } from "@/lib/board/templates";

// Applying writes only to the person's own site, so it needs a login but not
// a verified email.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const versionId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireUser();
    const result = await applyTemplate(user, versionId, {
      targetPath: body.targetPath,
      backup: body.backup,
      createCollections: body.createCollections,
      updates: body.updates,
    });
    return NextResponse.json({ success: true, result });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
