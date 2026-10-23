import { metadataJson, preflight } from "@/lib/mcp/http";
import { protectedResourceMetadata } from "@/lib/mcp/oauth";

// RFC 9728: which server signs apps in to /mcp. /mcp's 401 names the
// path-suffixed copy beside this one; some apps look here first.
export const GET = () => metadataJson(protectedResourceMetadata());
export const OPTIONS = preflight;
