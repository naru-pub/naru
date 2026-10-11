import { ownerAuthRequest } from "@/lib/site-data/auth-http";
import { protocolError } from "@/lib/site-data/validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  const { action } = await context.params;
  // What a website's SDK calls: exchange a code, revoke a token, for an
  // owner or a member.
  if (!["token", "revoke", "member-token", "member-revoke"].includes(action))
    return protocolError(404, "Not found.", undefined, {
      "Cache-Control": "no-store",
    });
  return ownerAuthRequest(request, action);
}
export { handle as GET, handle as POST, handle as OPTIONS };
