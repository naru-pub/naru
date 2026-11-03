import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { userHasFeature } from "@/lib/entitlements";
import { CORS, preflight } from "@/lib/mcp/http";
import { overRequestLimit } from "@/lib/mcp/limits";
import {
  grantForAccessToken,
  mcpResource,
  resourceMetadataUrl,
} from "@/lib/mcp/oauth";
import { naruMcpServer } from "@/lib/mcp/server";

// Naru MCP's endpoint (docs/design/naru-mcp.md), MCP's Streamable HTTP
// transport without sessions: each POST is answered in full as JSON by a
// server made for it, so any control-plane process can take any request and
// nothing is kept between them. There is no server-to-app stream, so GET and
// DELETE are refused, as the transport allows.

/**
 * The largest request, which the transport counts as it arrives and answers
 * with 413 past, before parsing it: room for write_file's largest file as
 * base64, 13.4 MiB, and its JSON around it.
 */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

function unauthorized(tokenGiven: boolean) {
  // RFC 9728 §5.1: where the app learns how to sign in.
  const challenge = [
    `Bearer resource_metadata="${resourceMetadataUrl()}"`,
    ...(tokenGiven
      ? [
          'error="invalid_token"',
          'error_description="The access token is invalid or expired"',
        ]
      : []),
  ].join(", ");
  return Response.json(
    { error: tokenGiven ? "invalid_token" : "unauthorized" },
    { status: 401, headers: { ...CORS, "WWW-Authenticate": challenge } },
  );
}

export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (\S+)$/i.exec(header);
  const grant = match ? await grantForAccessToken(match[1]) : null;
  if (!grant) return unauthorized(!!match);
  const entitled = await userHasFeature(grant.userId, "database");
  if (overRequestLimit(grant.userId, entitled))
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...CORS, "Retry-After": "60" } },
    );

  const server = naruMcpServer(grant, entitled);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_REQUEST_BYTES,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      authInfo: {
        token: match![1],
        clientId: grant.clientId,
        scopes: grant.scopes,
        expiresAt: grant.expiresAt,
        resource: new URL(mcpResource()),
      },
    });
    // The JSON answer is complete here; the body is read before the server
    // is closed below, so closing can't cut it short.
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
    return new Response(body.byteLength ? body : null, {
      status: response.status,
      headers,
    });
  } finally {
    await server.close();
  }
}

const notAllowed = () =>
  new Response(null, { status: 405, headers: { ...CORS, Allow: "POST" } });

export const GET = notAllowed;
export const DELETE = notAllowed;
export const OPTIONS = preflight;
