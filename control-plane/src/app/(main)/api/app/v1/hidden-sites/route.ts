import { appResponse, appUser } from "@/lib/app-api/http";
import { listHiddenSites } from "@/lib/app-api/moderation";

export const GET = (request: Request) =>
  appResponse(async () => listHiddenSites(await appUser(request)));
