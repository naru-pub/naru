import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedUser } from "@/lib/board/access";
import { TEMPLATE_PREVIEW_MAX_BYTES } from "@/lib/board/constants";
import {
  BoardError,
  boardErrorResponse,
  parseId,
  readJson,
} from "@/lib/board/errors";
import {
  removeTemplatePreview,
  setTemplatePreview,
} from "@/lib/board/templates";
import { assertSameOriginRequest } from "@/lib/utils";

// The template's own preview image: PUT the image itself as the body, as
// the file manager uploads files. A cross-site page can't send one, since a
// PUT needs CORS.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    try {
      assertSameOriginRequest(request);
    } catch {
      throw new BoardError(400, "잘못된 요청입니다.");
    }
    const user = await requireVerifiedUser();
    const templateId = parseId((await params).id);
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > TEMPLATE_PREVIEW_MAX_BYTES) {
      throw new BoardError(413, "미리보기 이미지가 너무 커요.");
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    await setTemplatePreview(user, templateId, bytes);
    return NextResponse.json({ success: true });
  } catch (error) {
    return boardErrorResponse(error);
  }
}

// Back to the screenshots of the template's versions.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await readJson(request);
    const user = await requireVerifiedUser();
    await removeTemplatePreview(user, parseId((await params).id));
    return NextResponse.json({ success: true });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
