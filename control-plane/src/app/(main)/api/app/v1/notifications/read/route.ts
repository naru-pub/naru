import { appBody, appResponse, appUser } from "@/lib/app-api/http";
import { markRead } from "@/lib/app-api/inbox";

export const POST = (request: Request) =>
  appResponse(async () =>
    markRead(await appUser(request), await appBody(request)),
  );
