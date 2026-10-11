import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { userHasFeature } from "@/lib/entitlements";
import { assertJsonContentType } from "@/lib/utils";
import { parseUuid } from "@/lib/uuid";
import { githubAppConfig } from "@/lib/deploy/githubApp";
import {
  connectRepository,
  DeployError,
  linkedRepositories,
  redeploy,
} from "@/lib/deploy/githubAppDeploy";
import { deployInBackground } from "@/lib/deploy/deployInBackground";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The /deploys page's side of Naru's GitHub App: the repositories the account
// may connect (GET), connecting one (POST), and deploying one now (PUT).

async function signedIn() {
  const { user } = await validateRequest();
  if (!user) return null;
  if (!(await userHasFeature(user.id, "github_deploys"))) return null;
  return user;
}

const failure = (error: unknown) =>
  NextResponse.json(
    {
      success: false,
      message:
        error instanceof DeployError
          ? error.message
          : "GitHub에 연결하지 못했습니다. 잠시 뒤에 다시 해 주세요.",
    },
    { status: error instanceof DeployError ? 400 : 502 },
  );

export async function GET() {
  const user = await signedIn();
  if (!user) return NextResponse.json({ success: false }, { status: 401 });
  if (!githubAppConfig())
    return NextResponse.json({ success: true, configured: false });
  try {
    return NextResponse.json({
      success: true,
      configured: true,
      installations: await linkedRepositories(user.id),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertJsonContentType(request);
  } catch {
    return NextResponse.json({ success: false }, { status: 400 });
  }
  const user = await signedIn();
  if (!user) return NextResponse.json({ success: false }, { status: 401 });
  try {
    const body = await request.json();
    const target = await connectRepository({
      userId: user.id,
      installationId: body.installationId,
      repositoryId: body.repositoryId,
      branch: body.branch,
      sourceDir: body.sourceDir,
      targetPrefix: body.targetPrefix,
    });
    deployInBackground();
    return NextResponse.json({ success: true, target });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    assertJsonContentType(request);
  } catch {
    return NextResponse.json({ success: false }, { status: 400 });
  }
  const user = await signedIn();
  if (!user) return NextResponse.json({ success: false }, { status: 401 });
  try {
    const id = parseUuid((await request.json()).id);
    if (!id) throw new DeployError("연결된 저장소를 찾지 못했습니다.");
    await redeploy(user.id, id);
    deployInBackground();
    return NextResponse.json({ success: true });
  } catch (error) {
    return failure(error);
  }
}
