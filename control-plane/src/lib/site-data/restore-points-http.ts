import { validateRequest } from "@/lib/auth";
import { RESTORE_POINT_CONTENT_TYPE } from "@/lib/site-functions/restore-points";
import {
  createRestorePoint,
  downloadRestorePoint,
  listRestorePoints,
  resetSiteDatabase,
  restoreRestorePoint,
} from "@/lib/site-functions/restore";
import {
  DataError,
  jsonBody,
  protocolError,
  sameOrigin,
  withRetryAfter,
} from "./validation";

/**
 * The owner's restore points on the control panel: GET lists them, GET
 * `?download=<name>` streams one as a file, POST `{ name }` restores one and
 * POST `{ create: true }` keeps one now and POST `{ reset: "<site>" }`
 * empties the site's database, keeping one first. Same origin and the owner's session
 * only, as membership administration (membership-http.ts).
 */
export async function restorePointsOwnerRequest(request: Request) {
  const headers = { "Cache-Control": "no-store", Vary: "Origin" };
  try {
    sameOrigin(request);
    const { user } = await validateRequest();
    if (!user) throw new DataError(401, "Sign in required.");
    const download = new URL(request.url).searchParams.get("download");
    if (request.method === "GET" && download !== null) {
      const point = await downloadRestorePoint(user.id, download);
      // Site and restore point names are ASCII ([a-zA-Z0-9_-] and the
      // name's own), so the filename needs no encoding.
      return new Response(point.body, {
        headers: {
          ...headers,
          "Content-Type": RESTORE_POINT_CONTENT_TYPE,
          "Content-Length": String(point.size),
          "Content-Disposition": `attachment; filename="${point.filename}"`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (request.method === "GET")
      return Response.json(
        { restorePoints: await listRestorePoints(user.id) },
        { headers },
      );
    const body = await jsonBody(request);
    if (body.create === true)
      return Response.json(await createRestorePoint(user.id), { headers });
    if (body.reset !== undefined)
      return Response.json(await resetSiteDatabase(user.id, body.reset), {
        headers,
      });
    return Response.json(await restoreRestorePoint(user.id, body.name), {
      headers,
    });
  } catch (error) {
    if (error instanceof DataError)
      return protocolError(
        error.status,
        error.message,
        error.code,
        withRetryAfter(headers, error.retryAfter),
      );
    console.error("Restore point request failed", error);
    return protocolError(
      500,
      "Restore point request failed.",
      undefined,
      headers,
    );
  }
}
