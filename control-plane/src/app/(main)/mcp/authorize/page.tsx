import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import { userHasFeature } from "@/lib/entitlements";
import {
  authorizeRequest,
  ConsentError,
  redirectHost,
  type AuthorizeRequest,
} from "@/lib/mcp/oauth";
import McpConsent from "./McpConsent";
import { PANEL } from "./panel";

export const metadata: Metadata = { title: "MCP 연결 · 나루" };

const FIELDS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
];

// Where an MCP app sends its sign-in (lib/mcp/oauth.ts): the person signs in
// to naru.pub, then connects the app to their site or declines.
export default async function McpAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Only the recognized scalar fields: the page never carries anything else.
  const query: Record<string, string> = {};
  for (const key of FIELDS)
    if (typeof params[key] === "string") query[key] = params[key];
  const { user } = await validateRequest();
  if (!user)
    redirect(
      `/login?next=${encodeURIComponent(
        `/mcp/authorize?${new URLSearchParams(query)}`,
      )}`,
    );
  let input: AuthorizeRequest;
  try {
    input = await authorizeRequest(query);
  } catch (error) {
    if (!(error instanceof ConsentError)) throw error;
    return (
      <div className={PANEL}>
        <h1 className="text-xl font-bold">앱을 연결할 수 없습니다</h1>
        <p role="alert">{error.message}</p>
      </div>
    );
  }
  return (
    <McpConsent
      request={query}
      appName={input.client.name}
      host={redirectHost(input.redirectUri)}
      scopes={input.scopes}
      account={user.loginName}
      entitled={await userHasFeature(user.id, "mcp")}
    />
  );
}
