import { NextResponse } from "next/server";
import { requireUser } from "@/lib/board/access";
import { boardErrorResponse } from "@/lib/board/errors";
import { listInstalls } from "@/lib/board/updates";

// The templates the signed-in person installed on their site.
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({
      success: true,
      installs: await listInstalls(user),
    });
  } catch (error) {
    return boardErrorResponse(error);
  }
}
