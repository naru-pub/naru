import { appBody, appResponse, optionalAppUser } from "@/lib/app-api/http";
import { report, requestIp } from "@/lib/app-api/moderation";

// Signed in or not: anyone shown a site in the app can report it.
export const POST = (request: Request) =>
  appResponse(async () =>
    report(
      { user: await optionalAppUser(request), ip: requestIp(request) },
      await appBody(request),
    ),
  );
