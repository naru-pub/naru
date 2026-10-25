import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { disconnectInstall, setInstallNotify } from "@/lib/board/updates";

// Whether the install is told of new versions: { notify: boolean }.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const installId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireUser();
    await setInstallNotify(user, installId, body.notify);
    return NextResponse.json({ success: true });
  } catch (error) {
    return boardErrorResponse(error);
  }
}

// Disconnects the install: its files stay, as the owner's own, or with
// { removeFiles: true } those still as the template wrote them go.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const installId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireUser();
    const result = await disconnectInstall(user, installId, {
      removeFiles: body.removeFiles === true,
    });
    return NextResponse.json({ success: true, result });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
