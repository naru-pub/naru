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

// Disconnects the install: its files stay, as the owner's own.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const installId = parseId((await params).id);
    await readJson(request);
    const user = await requireUser();
    await disconnectInstall(user, installId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
