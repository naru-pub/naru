import { appResponse, appUser } from "@/lib/app-api/http";
import { listStarredSites } from "@/lib/app-api/stars";

export const GET = (request: Request) =>
  appResponse(async () => listStarredSites(await appUser(request)));
