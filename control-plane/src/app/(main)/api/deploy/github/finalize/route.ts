import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import * as Sentry from "@sentry/nextjs";
import {
  getBearerToken,
  verifyGitHubActionsToken,
} from "@/lib/deploy/githubOidc";
import { finalizeGitHubDeployment } from "@/lib/deploy/siteDeploy";
import {
  finalizeTemplateUpload,
  isTemplateUpload,
} from "@/lib/board/template-uploads";

export async function POST(request: NextRequest) {
  try {
    const token = getBearerToken(request.headers);
    if (!token) {
      return NextResponse.json(
        { success: false, message: "Missing GitHub OIDC bearer token" },
        { status: 401 },
      );
    }

    const claims = await verifyGitHubActionsToken(token);
    const body = await request.json();
    const deploymentId = String(body.deploymentId ?? "");
    if (!deploymentId) {
      return NextResponse.json(
        { success: false, message: "deploymentId is required" },
        { status: 400 },
      );
    }

    if (await isTemplateUpload(deploymentId)) {
      const result = await finalizeTemplateUpload({ claims, deploymentId });
      return NextResponse.json({ success: true, ...result });
    }
    const result = await finalizeGitHubDeployment({ claims, deploymentId });
    revalidatePath("/files", "layout");

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Failed to finalize deploy",
      },
      { status: 400 },
    );
  }
}
