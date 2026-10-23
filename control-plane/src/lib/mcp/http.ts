import { OAuthError } from "./oauth";

// MCP apps call the metadata, registration, token and /mcp endpoints from
// their servers, but some (MCP Inspector, apps in a browser) call them from a
// page. None of them reads a cookie, so any origin may.
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

export const preflight = () =>
  new Response(null, { status: 204, headers: CORS });

/** JSON for an OAuth endpoint: never cached (RFC 6749 §5.1). */
export const oauthJson = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { ...CORS, "Cache-Control": "no-store", Pragma: "no-cache" },
  });

/** Discovery metadata, the same for everyone, cached for an hour. */
export const metadataJson = (body: unknown) =>
  Response.json(body, {
    headers: { ...CORS, "Cache-Control": "public, max-age=3600" },
  });

/** An OAuth endpoint's answer, with errors in RFC 6749 §5.2's shape. */
export async function oauthResponse(run: () => Promise<unknown>, status = 200) {
  try {
    return oauthJson(await run(), status);
  } catch (error) {
    if (error instanceof OAuthError)
      return oauthJson(
        { error: error.error, error_description: error.message },
        error.status,
      );
    console.error("MCP OAuth error:", error);
    return oauthJson(
      { error: "server_error", error_description: "Something went wrong." },
      500,
    );
  }
}
