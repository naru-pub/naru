import { appResponse, appUser } from "@/lib/app-api/http";
import { listNotifications } from "@/lib/app-api/inbox";

export const GET = (request: Request) =>
  appResponse(async () =>
    listNotifications(
      await appUser(request),
      new URL(request.url).searchParams.get("before"),
    ),
  );
