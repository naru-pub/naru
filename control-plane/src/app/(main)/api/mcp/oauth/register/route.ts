import { oauthResponse, preflight } from "@/lib/mcp/http";
import { OAuthError, registerClient } from "@/lib/mcp/oauth";

// RFC 7591 dynamic registration, open to anyone, as MCP apps expect.
export const POST = (request: Request) =>
  oauthResponse(async () => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new OAuthError(400, "invalid_client_metadata", "Expected JSON.");
    }
    return registerClient(body);
  }, 201);
export const OPTIONS = preflight;
