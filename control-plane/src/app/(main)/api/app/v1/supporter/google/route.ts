import { appBody, appResponse, appUser } from "@/lib/app-api/http";
import { claimGooglePurchase } from "@/lib/app-api/supporter";

export const POST = (request: Request) =>
  appResponse(async () =>
    claimGooglePurchase(await appUser(request), await appBody(request)),
  );
