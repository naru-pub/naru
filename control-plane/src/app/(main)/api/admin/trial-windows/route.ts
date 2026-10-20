import { NextRequest, NextResponse } from "next/server";
import { adminFailure, operatorJson } from "@/lib/admin-api";
import { createTrialWindow, parseTrialWindow } from "@/lib/supporter-trial";

// Opens a window in which accounts may claim a free trial (/admin/trials).
export async function POST(request: NextRequest) {
  const operator = await operatorJson(request);
  if ("refused" in operator) return operator.refused;
  const window = parseTrialWindow(operator.body);
  if (typeof window === "string") return adminFailure(window);
  await createTrialWindow(window, operator.user.loginName);
  return NextResponse.json({ success: true });
}
