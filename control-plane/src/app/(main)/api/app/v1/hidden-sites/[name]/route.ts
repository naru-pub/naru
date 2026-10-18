import { appResponse, appUser } from "@/lib/app-api/http";
import { hideSite, showSite } from "@/lib/app-api/moderation";

type Params = { params: Promise<{ name: string }> };

// Hide a site from the account's showcase and inbox (PUT), or show it again.
export const PUT = (request: Request, { params }: Params) =>
  appResponse(async () => {
    await hideSite(await appUser(request), (await params).name);
  });

export const DELETE = (request: Request, { params }: Params) =>
  appResponse(async () => {
    await showSite(await appUser(request), (await params).name);
  });
