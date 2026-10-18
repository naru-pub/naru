import { appResponse, appUser } from "@/lib/app-api/http";
import { deleteNotification } from "@/lib/app-api/inbox";

export const DELETE = (
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) =>
  appResponse(async () =>
    deleteNotification(await appUser(request), (await params).id),
  );
