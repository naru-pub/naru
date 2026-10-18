import { appResponse, appUser } from "@/lib/app-api/http";
import { revokeAppToken } from "@/lib/app-api/tokens";

// Sign-out: the token and every device it registered.
export const DELETE = (request: Request) =>
  appResponse(async () => {
    await revokeAppToken((await appUser(request)).tokenId);
  });
