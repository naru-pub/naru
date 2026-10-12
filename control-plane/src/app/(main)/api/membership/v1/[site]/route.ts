import { membershipStatusRequest } from "@/lib/site-data/membership-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ site: string }> };
async function handle(request: Request, context: Context) {
  return membershipStatusRequest(request, (await context.params).site);
}
export { handle as GET, handle as OPTIONS };
