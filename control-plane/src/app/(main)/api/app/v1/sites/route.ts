import { appResponse, appUser } from "@/lib/app-api/http";
import { listSites } from "@/lib/app-api/inbox";

export const GET = (request: Request) =>
  appResponse(async () => listSites(await appUser(request)));
