import { validateRequest } from "@/lib/auth";
import { appBody, appResponse } from "@/lib/app-api/http";
import {
  approveAuthorization,
  ConsentError,
  authorizeRequest,
  deniedRedirect,
  parseScope,
} from "@/lib/mcp/oauth";
import { DataError, sameOrigin } from "@/lib/site-data/validation";

// The buttons on /mcp/authorize: naru.pub's own page, signed in with its
// session cookie, so only same-origin requests. The body is the page's query
// with the person's answer: approve and the scopes they kept, or decline.
export const POST = (request: Request) =>
  appResponse(async () => {
    sameOrigin(request);
    const { user } = await validateRequest();
    if (!user)
      throw new DataError(401, "나루에 다시 로그인해 주세요.", "AUTH_REQUIRED");
    const body = await appBody(request);
    let redirect: string;
    try {
      const query =
        body.request && typeof body.request === "object"
          ? (body.request as Record<string, unknown>)
          : {};
      const input = await authorizeRequest(query);
      redirect = body.approve
        ? await approveAuthorization(
            user.id,
            input,
            // No scope kept is no scope, not parseScope's "all of them".
            typeof body.scope === "string" && body.scope
              ? parseScope(body.scope)
              : [],
          )
        : deniedRedirect(input);
    } catch (error) {
      if (error instanceof ConsentError)
        throw new DataError(400, error.message);
      throw error;
    }
    return { redirect };
  });
