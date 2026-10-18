import { appBody, appResponse, appUser } from "@/lib/app-api/http";
import { claimApplePurchases } from "@/lib/app-api/supporter";

export const POST = (request: Request) =>
  appResponse(async () =>
    claimApplePurchases(await appUser(request), await appBody(request)),
  );
