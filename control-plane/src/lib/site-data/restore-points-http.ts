import { validateRequest } from "@/lib/auth";
import {
  listRestorePoints,
  restoreRestorePoint,
} from "@/lib/site-functions/restore";
import { DataError, jsonBody, protocolError, sameOrigin } from "./validation";

/**
 * The owner's restore points on the control panel: GET lists them, POST
 * `{ name }` restores one. Same origin and the owner's session only, as
 * membership administration (membership-http.ts).
 */
export async function restorePointsOwnerRequest(request: Request) {
  const headers = { "Cache-Control": "no-store", Vary: "Origin" };
  try {
    sameOrigin(request);
    const { user } = await validateRequest();
    if (!user) throw new DataError(401, "Sign in required.");
    if (request.method === "GET")
      return Response.json(
        { restorePoints: await listRestorePoints(user.id) },
        { headers },
      );
    const body = await jsonBody(request);
    return Response.json(await restoreRestorePoint(user.id, body.name), {
      headers,
    });
  } catch (error) {
    if (error instanceof DataError)
      return protocolError(error.status, error.message, error.code, headers);
    console.error("Restore point request failed", error);
    return protocolError(
      500,
      "Restore point request failed.",
      undefined,
      headers,
    );
  }
}
