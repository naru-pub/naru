import { appResponse, appUser } from "@/lib/app-api/http";
import { appSupporter, storeParam } from "@/lib/app-api/supporter";

export const GET = (request: Request) =>
  appResponse(async () =>
    appSupporter(
      await appUser(request),
      storeParam(new URL(request.url).searchParams.get("store")),
    ),
  );
