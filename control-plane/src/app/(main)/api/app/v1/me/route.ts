import { appResponse, appUser } from "@/lib/app-api/http";

export const GET = (request: Request) =>
  appResponse(async () => ({
    account: { loginName: (await appUser(request)).loginName },
  }));
