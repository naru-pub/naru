import { NextRequest, NextResponse } from "next/server";
import { adminFailure, operatorJson } from "@/lib/admin-api";
import { deleteTrialWindow, endTrialWindow } from "@/lib/supporter-trial";
import { parseUuid } from "@/lib/uuid";

type Context = { params: Promise<{ id: string }> };

// `{ end: true }` closes an open window now. Trials claimed in it keep running.
export async function PATCH(request: NextRequest, context: Context) {
  const operator = await operatorJson(request);
  if ("refused" in operator) return operator.refused;
  const id = parseUuid((await context.params).id);
  if (!id || operator.body.end !== true)
    return adminFailure("잘못된 요청이에요.");
  if (!(await endTrialWindow(id)))
    return adminFailure("열려 있는 기간이 아니에요.", 409);
  return NextResponse.json({ success: true });
}

// Removes a window nobody claimed in.
export async function DELETE(request: NextRequest, context: Context) {
  const operator = await operatorJson(request);
  if ("refused" in operator) return operator.refused;
  const id = parseUuid((await context.params).id);
  if (!id) return adminFailure("기간을 찾지 못했어요.", 404);
  if (!(await deleteTrialWindow(id)))
    return adminFailure(
      "신청이 있는 기간은 지울 수 없어요. 지금 끝내기를 쓰세요.",
      409,
    );
  return NextResponse.json({ success: true });
}
