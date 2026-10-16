import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { validateRequest } from "@/lib/auth";
import { userHasFeature } from "@/lib/entitlements";
import {
  githubAppConfig,
  userInstallations,
  userToken,
  verifyWebhookSignature,
} from "@/lib/deploy/githubApp";
import {
  forgetInstallation,
  linkInstallations,
  queuePush,
} from "@/lib/deploy/githubAppDeploy";
import { deployInBackground } from "@/lib/deploy/deployInBackground";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Naru's GitHub App (docs/github-app.md):
// - install: from /github, to GitHub's page that installs the App;
// - connect: the same, for an App already installed, through GitHub sign-in;
// - callback: where GitHub returns either way, with the person's OAuth code;
// - webhook: GitHub's deliveries, signed with the App's webhook secret.
const STATE_COOKIE = "naru_github_state";
// Behind the gateway, request.url is the container's own address: redirects
// within Naru are made on its public one.
const naru = (request: Request, path: string) =>
  new URL(path, process.env.BASE_URL ?? request.url);
const home = (request: Request, query: string) =>
  NextResponse.redirect(naru(request, `/github?github=${query}`));

async function start(request: Request, action: "install" | "connect") {
  const config = githubAppConfig();
  const { user } = await validateRequest();
  if (!user) return NextResponse.redirect(naru(request, "/login"));
  if (!config || !(await userHasFeature(user.id, "github_deploys")))
    return home(request, "unavailable");
  const state = randomBytes(24).toString("base64url");
  (await cookies()).set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/github",
    maxAge: 10 * 60,
  });
  const target =
    action === "install"
      ? new URL(`https://github.com/apps/${config.slug}/installations/new`)
      : new URL("https://github.com/login/oauth/authorize");
  if (action === "connect")
    target.searchParams.set("client_id", config.clientId);
  target.searchParams.set("state", state);
  return NextResponse.redirect(target);
}

/**
 * GitHub's return: the OAuth code of the person who installed the App or
 * signed in. Their token is used once, to learn which installations and
 * repositories they can read, and then dropped.
 */
async function callback(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  jar.delete({ name: STATE_COOKIE, path: "/api/github" });
  const { user } = await validateRequest();
  if (!user) return NextResponse.redirect(naru(request, "/login"));
  const code = url.searchParams.get("code");
  if (!code || !expected || url.searchParams.get("state") !== expected)
    return home(request, "expired");
  try {
    await linkInstallations(
      user.id,
      await userInstallations(await userToken(code)),
    );
  } catch (error) {
    console.error("[github-app] linking failed", error);
    return home(request, "failed");
  }
  return home(request, "connected");
}

async function webhook(request: Request) {
  if (!githubAppConfig())
    return NextResponse.json({ error: "Not configured." }, { status: 404 });
  const body = await request.text();
  if (!verifyWebhookSignature(body, request.headers.get("x-hub-signature-256")))
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(body);
  const installationId = payload.installation?.id
    ? String(payload.installation.id)
    : null;
  if (event === "push" && installationId && !payload.deleted) {
    const marked = await queuePush({
      installationId,
      repositoryId: String(payload.repository.id),
      repository: String(payload.repository.full_name),
      ref: String(payload.ref),
      sha: String(payload.after),
    });
    // Answered now; deployed after. The minute runner picks up what this misses.
    if (marked) deployInBackground();
    return NextResponse.json({ marked }, { status: 202 });
  }
  if (
    event === "installation" &&
    installationId &&
    ["deleted", "suspend"].includes(payload.action)
  )
    await forgetInstallation(installationId);
  if (
    event === "installation_repositories" &&
    installationId &&
    payload.action === "removed"
  )
    await forgetInstallation(
      installationId,
      (payload.repositories_removed ?? []).map((repository: { id: number }) =>
        String(repository.id),
      ),
    );
  return NextResponse.json({ ok: true }, { status: 202 });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  const { action } = await context.params;
  if (action === "install" || action === "connect")
    return start(request, action);
  if (action === "callback") return callback(request);
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  const { action } = await context.params;
  if (action === "webhook") return webhook(request);
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}
