import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { clearSiteBreaker, siteBreakerTrips } from "@/lib/edge/breakers";
import {
  DataError,
  jsonBody,
  protocolError,
  sameOrigin,
  withRetryAfter,
} from "./validation";

/**
 * The owner's paused statements on the control panel (중지된 쿼리,
 * lib/edge/breakers.ts): GET lists the site's latest pauses, POST `{ key }`
 * lets that one run again (다시 허용). Same origin and the owner's session
 * only, as restore points (restore-points-http.ts).
 */
export async function stoppedQueriesOwnerRequest(request: Request) {
  const headers = { "Cache-Control": "no-store", Vary: "Origin" };
  try {
    sameOrigin(request);
    const { user } = await validateRequest();
    if (!user) throw new DataError(401, "Sign in required.");
    if (!(await userHasFeature(user.id, "database")))
      throw new DataError(403, "Database access is not enabled for this site.");
    const { login_name: site } = await db
      .selectFrom("users")
      .select("login_name")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    if (request.method === "GET")
      return Response.json(
        { trips: await siteBreakerTrips(site) },
        { headers },
      );
    const { key } = await jsonBody(request);
    if (typeof key !== "string" || !key || key.length > 1024)
      throw new DataError(400, "Choose a paused statement.");
    await clearSiteBreaker(site, key);
    return Response.json({ cleared: key }, { headers });
  } catch (error) {
    if (error instanceof DataError)
      return protocolError(
        error.status,
        error.message,
        error.code,
        withRetryAfter(headers, error.retryAfter),
      );
    console.error("Stopped queries request failed", error);
    return protocolError(
      500,
      "Stopped queries request failed.",
      undefined,
      headers,
    );
  }
}
