import { appResponse, appUser } from "@/lib/app-api/http";
import { listNotifications } from "@/lib/app-api/inbox";

export const GET = (request: Request) =>
  appResponse(async () => {
    const params = new URL(request.url).searchParams;
    return listNotifications(
      await appUser(request),
      params.get("before"),
      params.get("site"),
    );
  });
