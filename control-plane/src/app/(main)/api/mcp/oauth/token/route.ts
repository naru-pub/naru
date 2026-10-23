import { oauthResponse, preflight } from "@/lib/mcp/http";
import { exchangeToken, OAuthError } from "@/lib/mcp/oauth";

// RFC 6749 §3.2: form-encoded, for a code or a refresh token.
export const POST = (request: Request) =>
  oauthResponse(async () => {
    if (
      !request.headers
        .get("content-type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      throw new OAuthError(
        400,
        "invalid_request",
        "Use application/x-www-form-urlencoded.",
      );
    return exchangeToken(new URLSearchParams(await request.text()));
  });
export const OPTIONS = preflight;
