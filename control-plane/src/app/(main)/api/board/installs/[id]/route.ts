import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse, parseId, readJson } from "@/lib/board/errors";
import { disconnectInstall, setUpdatePreference } from "@/lib/board/updates";

// How the install takes new versions: { updates: notify | auto | never }.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const installId = parseId((await params).id);
    const body = await readJson(request);
    const user = await requireUser();
    await setUpdatePreference(user, installId, body.updates);
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
