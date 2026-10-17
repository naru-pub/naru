import { validateRequest } from "@/lib/auth";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { manageMembership } from "./membership";
import { OWNER_EXPIRES, OWNER_EXPIRES_IN, websiteHeaders } from "./protocol";
import {
  DataError,
  jsonBody,
  name,
  protocolError,
  sameOrigin,
  withRetryAfter,
} from "./validation";

function failure(error: unknown, headers: Record<string, string>) {
  if (error instanceof DataError)
    return protocolError(
      error.status,
      error.message,
      error.code,
      withRetryAfter(headers, error.retryAfter),
    );
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
