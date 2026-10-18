import { appResponse, appUser } from "@/lib/app-api/http";
import { starSite, unstarSite } from "@/lib/site-stars";

type Params = { params: Promise<{ name: string }> };

// Star a site for the account (PUT), or unstar it.
export const PUT = (request: Request, { params }: Params) =>
  appResponse(async () => {
    await starSite((await appUser(request)).id, (await params).name);
  });

export const DELETE = (request: Request, { params }: Params) =>
  appResponse(async () => {
    await unstarSite((await appUser(request)).id, (await params).name);
  });
