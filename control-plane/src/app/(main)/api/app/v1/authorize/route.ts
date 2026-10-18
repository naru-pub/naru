import { validateRequest } from "@/lib/auth";
import { appBody, appResponse } from "@/lib/app-api/http";
import {
  approveAuthorization,
  authorizeInput,
} from "@/lib/app-api/tokens";
import { DataError, sameOrigin } from "@/lib/site-data/validation";

// The approve button on /app/authorize: naru.pub's own page, signed in with
// its session cookie, so only same-origin requests.
export const POST = (request: Request) =>
  appResponse(async () => {
    sameOrigin(request);
    const { user } = await validateRequest();
    if (!user)
      throw new DataError(401, "나루에 다시 로그인해 주세요.", "AUTH_REQUIRED");
    const input = authorizeInput(await appBody(request));
    return { redirect: await approveAuthorization(user.id, input) };
  });
