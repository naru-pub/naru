import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { memberIdentity } from "./member-auth";
import { manageMembership } from "./membership";
import { OWNER_EXPIRES, OWNER_EXPIRES_IN, websiteHeaders } from "./protocol";
import {
  DataError,
  jsonBody,
  name,
  protocolError,
  sameOrigin,
} from "./validation";

function failure(error: unknown, headers: Record<string, string>) {
  if (error instanceof DataError)
    return protocolError(error.status, error.message, error.code, headers);
  console.error("Membership request failed", error);
  return protocolError(500, "Membership request failed.", undefined, headers);
}

export async function membershipOwnerRequest(request: Request) {
  const headers = { "Cache-Control": "no-store", Vary: "Origin" };
  try {
    sameOrigin(request);
    const { user } = await validateRequest();
    if (!user) throw new DataError(401, "Sign in required.");
    return Response.json(
      await manageMembership(
        user.id,
        request.method,
        request.method === "PATCH" ? await jsonBody(request) : {},
        new URL(request.url).searchParams.get("after") ?? undefined,
      ),
      { headers },
    );
  } catch (error) {
    return failure(error, headers);
  }
}

export async function membershipStatusRequest(request: Request, site: string) {
  const headers = websiteHeaders(request);
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  try {
    if (request.method !== "GET")
      throw new DataError(405, "Method not allowed.");
    const match = /^Bearer (m\.[A-Za-z0-9_-]{43})$/i.exec(
      request.headers.get("authorization") ?? "",
    );
    if (!match) throw new DataError(401, "Invalid member token.");
    const bearer: { token: string; origin: string | null; expiresAt?: number } =
      { token: match[1], origin: request.headers.get("origin") };
    const member = await db.transaction().execute(async (tx) => {
      const owner = await tx
        .selectFrom("users")
        .select("id")
        .where("login_name", "=", name(site))
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!owner) throw new DataError(404, "Site not found.");
      if (!(await userHasFeature(owner.id, "database", tx)))
        throw new DataError(
          403,
          "Database access is not enabled for this site.",
        );
      return memberIdentity(tx, owner.id, bearer);
    });
    if (bearer.expiresAt) {
      headers[OWNER_EXPIRES] = String(bearer.expiresAt);
      headers[OWNER_EXPIRES_IN] = String(
        Math.max(0, Math.floor((bearer.expiresAt - Date.now()) / 1000)),
      );
    }
    return Response.json(member, { headers });
  } catch (error) {
    return failure(error, headers);
  }
}
