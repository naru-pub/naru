import { appBody, appResponse, appUser } from "@/lib/app-api/http";
import { setSiteState } from "@/lib/app-api/inbox";

export const PUT = (
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) =>
  appResponse(async () =>
    setSiteState(
      await appUser(request),
      (await params).name,
      await appBody(request),
    ),
  );
