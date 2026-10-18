import { DataError, jsonBody, protocolError } from "@/lib/site-data/validation";
import { appTokenUser, type AppUser } from "./tokens";

// The app API (docs/design/naru-app.md): JSON in, JSON out, errors in the
// Data API's `{ error: { code, message } }` shape. The apps show `message` as
// is, so Naru's own messages here are written for the person holding the app.

const NO_STORE = { "Cache-Control": "no-store" };

export async function appResponse(
  run: () => Promise<Response | unknown>,
): Promise<Response> {
  try {
    const result = await run();
    if (result instanceof Response) return result;
    if (result === undefined)
      return new Response(null, { status: 204, headers: NO_STORE });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof DataError)
      return protocolError(
        error.status,
        error.message,
        error.code,
        error.retryAfter
          ? { ...NO_STORE, "Retry-After": String(error.retryAfter) }
          : NO_STORE,
      );
    console.error("App API error:", error);
    return protocolError(
      500,
      "나루에서 문제가 생겼습니다. 잠시 뒤에 다시 시도해 주세요.",
      undefined,
      NO_STORE,
    );
  }
}

/** The account an `Authorization: Bearer` app token belongs to. */
export async function appUser(request: Request): Promise<AppUser> {
  const match = /^Bearer (a\.[A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  const user = match ? await appTokenUser(match[1]) : null;
  if (!user)
    throw new DataError(401, "다시 로그인해 주세요.", "AUTH_REQUIRED");
  return user;
}

/** The account, when the request carries a valid app token; null otherwise. */
export async function optionalAppUser(request: Request): Promise<AppUser | null> {
  const match = /^Bearer (a\.[A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  return match ? appTokenUser(match[1]) : null;
}

export async function appBody(request: Request) {
  try {
    return await jsonBody(request);
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError(400, "요청을 읽지 못했습니다.");
  }
}

export function text(value: unknown, max: number, message: string): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new DataError(400, message);
  return value;
}
