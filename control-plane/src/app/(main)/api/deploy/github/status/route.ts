import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  getBearerToken,
  verifyGitHubActionsToken,
} from "@/lib/deploy/githubOidc";
import { githubDeploymentStatus } from "@/lib/deploy/siteDeploy";

// After finalize answers `functions: { status: "activating" }`, the workflow
// polls here until the site's code is active, or refused.
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

    const result = await githubDeploymentStatus({ claims, deploymentId });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json(
      {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Failed to read the deployment",
      },
      { status: 400 },
    );
  }
}
