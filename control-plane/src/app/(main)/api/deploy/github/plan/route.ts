import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import {
  getBearerToken,
  verifyGitHubActionsToken,
} from "@/lib/deploy/githubOidc";
import { createGitHubDeploymentPlan } from "@/lib/deploy/siteDeploy";
import { planTemplateUpload } from "@/lib/board/template-uploads";

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
    // A template's workflow names the template instead of a site.
    const plan = body.template
      ? await planTemplateUpload({
          claims,
          templateId: String(body.template),
          manifest: body.manifest,
          changelog: body.changelog,
        })
      : await createGitHubDeploymentPlan({
          claims,
          site: String(body.site ?? ""),
          targetPrefix: body.targetPrefix,
          manifest: body.manifest,
        });

    return NextResponse.json({ success: true, ...plan });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Failed to plan deploy",
      },
      { status: 400 },
    );
  }
}
