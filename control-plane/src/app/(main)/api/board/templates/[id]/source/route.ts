import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { setTemplateSource } from "@/lib/board/templates";

// Where the template's new versions come from: the author's site, or a
// GitHub Actions workflow on a repository and ref.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const templateId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireVerifiedUser();
    await setTemplateSource(user, templateId, {
      source: body.source,
      githubRepository: body.githubRepository,
      githubRef: body.githubRef,
      githubPath: body.githubPath,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
