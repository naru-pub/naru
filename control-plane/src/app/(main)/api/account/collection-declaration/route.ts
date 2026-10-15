import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { userHasFeature } from "@/lib/entitlements";
import { assertJsonContentType } from "@/lib/utils";
import {
  applyDeclaration,
  declaredPlan,
  readDeclaration,
} from "@/lib/site-data/declared-collections";
import { DataError } from "@/lib/site-data/validation";

// The owner's view of their site's _naru/collections.json on /database: what
// it would still create or change (GET), and approving it (POST). See
// lib/site-data/declared-collections.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function owner() {
  const { user } = await validateRequest();
  if (!user) throw new DataError(401, "로그인이 필요합니다.");
  if (!(await userHasFeature(user.id, "database")))
    throw new DataError(403, "데이터베이스는 서포터 플랜에 포함되어 있습니다.");
  return { id: String(user.id), loginName: user.loginName };
}

function failed(error: unknown) {
  if (error instanceof DataError)
    return NextResponse.json(
      { message: error.message },
      { status: error.status },
    );
  console.error("collection declaration failed", error);
  return NextResponse.json(
    { message: "컬렉션 선언을 확인하지 못했습니다." },
    { status: 500 },
  );
}

export async function GET() {
  try {
    const site = await owner();
    const declared = await readDeclaration(site.loginName);
    if (!declared) return NextResponse.json({ declared: null, plan: null });
    return NextResponse.json({
      declared,
      plan: await declaredPlan(site, declared),
    });
  } catch (error) {
    return failed(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertJsonContentType(request);
  } catch {
    return NextResponse.json(
      { message: "Invalid content type" },
      { status: 400 },
    );
  }
  try {
    const created = await applyDeclaration(await owner());
    return NextResponse.json({ created });
  } catch (error) {
    return failed(error);
  }
}
