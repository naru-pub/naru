import { appBody, appResponse } from "@/lib/app-api/http";
import { exchangeCode } from "@/lib/app-api/tokens";

export const POST = (request: Request) =>
  appResponse(async () => exchangeCode(await appBody(request)));
