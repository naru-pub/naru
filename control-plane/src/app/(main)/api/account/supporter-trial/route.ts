import { NextRequest, NextResponse } from "next/server";
import { assertJsonContentType } from "@/lib/utils";
import { validateRequest } from "@/lib/auth";
import { AccountBusyError } from "@/lib/payments/account-lock";
import { claimTrial, TRIAL_DAYS, TrialError } from "@/lib/supporter-trial";

// Starts the account's free trial of the supporter plan (lib/supporter-trial).
export async function POST(request: NextRequest) {
  try {
    // JSON only: a form a page on a user's subdomain posts (same site, so the
    // session cookie goes along) cannot set this type.
    assertJsonContentType(request);
  } catch {
    return NextResponse.json(
      { success: false, message: "잘못된 요청입니다." },
      { status: 400 },
    );
  }
  const { user } = await validateRequest();
  if (!user) {
    return NextResponse.json(
      { success: false, message: "로그인이 필요합니다." },
      { status: 401 },
    );
  }
  try {
    const { endsAt } = await claimTrial(user.id);
    return NextResponse.json({
      success: true,
      endsAt: endsAt.toISOString(),
      message: `${TRIAL_DAYS}일 무료 체험을 시작했습니다.`,
    });
  } catch (error) {
    if (error instanceof TrialError) {
      return NextResponse.json(
        { success: false, message: error.message },
        { status: error.status },
      );
    }
    if (error instanceof AccountBusyError) {
      return NextResponse.json(
        {
          success: false,
          message: "결제를 처리하고 있습니다. 잠시 후 다시 시도해 주세요.",
        },
        { status: 409 },
      );
    }
    console.error("Supporter trial claim error:", error);
    return NextResponse.json(
      { success: false, message: "무료 체험을 시작하지 못했습니다." },
      { status: 500 },
    );
  }
}
