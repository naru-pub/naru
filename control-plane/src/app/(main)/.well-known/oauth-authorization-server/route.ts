import { metadataJson, preflight } from "@/lib/mcp/http";
import { authorizationServerMetadata } from "@/lib/mcp/oauth";

// RFC 8414: where MCP apps register, send people to sign in, and get tokens.
export const GET = () => metadataJson(authorizationServerMetadata());
export const OPTIONS = preflight;
