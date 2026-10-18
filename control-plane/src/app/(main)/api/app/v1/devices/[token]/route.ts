import { appResponse, appUser } from "@/lib/app-api/http";
import { removeDevice } from "@/lib/app-api/inbox";

export const DELETE = (
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) =>
  appResponse(async () => {
    await removeDevice(await appUser(request), (await params).token);
  });
