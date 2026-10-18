import { appBody, appResponse, appUser } from "@/lib/app-api/http";
import { registerDevice } from "@/lib/app-api/inbox";

export const PUT = (request: Request) =>
  appResponse(async () => {
    await registerDevice(await appUser(request), await appBody(request));
  });
