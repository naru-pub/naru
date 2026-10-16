export const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_DOCUMENT_BYTES = 64 * 1024;
export const MAX_SITE_BYTES = 100 * 1024 * 1024;
// About 1 KiB a document at the byte limit; a search that reads every
// document then takes about 0.1 s on the mini.
export const MAX_DOCUMENTS = 100_000;
export const MAX_COLLECTIONS = 100;

/**
 * The failure codes of the v1 data protocol. A browser SDK released against
 * v1 knows exactly these, so a new one needs a new protocol version; HTTP
 * statuses stay diagnostic.
 */
export const ERROR_CODES = [
  "CONFLICT",
  "QUOTA_EXCEEDED",
  "AUTH_REQUIRED",
  "ACCESS_DENIED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "UNAVAILABLE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class DataError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Only where the status alone would name the wrong code. */
    public code?: ErrorCode,
    /** A site function's own JSON for its caller, from ctx.fail. */
    public details?: unknown,
    /**
     * The message is a site function's own, from ctx.fail, written for the
     * page's visitors; SDK 1.1.0 shows it as is and words Naru's own errors.
     */
    public site?: boolean,
  ) {
    super(message);
  }
}

function statusCode(status: number): ErrorCode {
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "ACCESS_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UNAVAILABLE";
  return "INVALID_REQUEST";
}

/** The v1 error body: `{ error: { code, message } }`. */
export function protocolError(
  status: number,
  message: string,
  code?: ErrorCode,
  headers?: HeadersInit,
  details?: unknown,
  site?: boolean,
) {
  return Response.json(
    {
      error: {
        code: code ?? statusCode(status),
        message,
        ...(details === undefined ? {} : { details }),
        ...(site ? { site: true } : {}),
      },
    },
    { status, headers },
  );
}

/**
 * A collection name. Names starting with an underscore are reserved for the
 * protocol's own paths (`_batch`, `_files`, `_call`), which a collection would
 * shadow.
 */
export function unreservedName(value: unknown): string {
  const result = name(value);
  if (result.startsWith("_"))
    throw new DataError(400, "Collection names cannot start with _.");
  return result;
}

export function name(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new DataError(
      400,
      "Names must contain 1–64 letters, numbers, underscores or hyphens.",
    );
  }
  return value;
}

/**
 * Who may read a collection: its owner, any signed-in member of the site as
 * well, or anyone.
 */
export function permission(value: unknown): "admin" | "member" | "world" {
  if (value !== "admin" && value !== "member" && value !== "world")
    throw new DataError(400, "Invalid permission.");
  return value;
}

/**
 * Who may write to it. `create` lets anyone add documents and no one else
 * change them; `member` lets members add documents and change their own.
 */
export function writePermission(
  value: unknown,
): "admin" | "create" | "member" | "world" {
  return value === "create" ? "create" : permission(value);
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  // Next can reconstruct request.url with its internal localhost address behind
  // a reverse proxy. Use an explicit canonical origin in production, never a
  // client-controlled forwarded host header, for owner authorization.
  const configured =
    process.env.SITE_DATA_CONTROL_PLANE_ORIGIN ||
    (process.env.NODE_ENV === "production"
      ? `https://${process.env.NEXT_PUBLIC_DOMAIN || "naru.pub"}`
      : null);
  const expectedOrigin = new URL(configured || request.url).origin;
  if (
    (origin && origin !== expectedOrigin) ||
    (!origin && request.method !== "GET") ||
    ["cross-site", "same-site"].includes(
      request.headers.get("sec-fetch-site") ?? "",
    )
  ) {
    throw new DataError(403, "Same-origin admin request required.");
  }
}

// Bound the stream, not just Content-Length (which clients can omit or forge).
export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  ) {
    throw new DataError(415, "Use application/json.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new DataError(400, "JSON body required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new DataError(413, "Request exceeds 64 KiB.");
    }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new DataError(400, "Expected a JSON object.");
  }
}

/** Canonical UUID syntax; accepts historical v4 and current v7 identities. */
export function uuidId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new DataError(400, "Invalid UUID identifier.");
  }
  return value.toLowerCase();
}

/** A nested module path and its export; every segment is a plain name. */
export function functionModule(value: unknown): string {
  if (typeof value !== "string")
    throw new DataError(400, "Invalid function module.");
  return value.split("/").map(name).join("/");
}
export function functionReference(value: string) {
  const parts = value.split(":");
  if (parts.length !== 2) throw new DataError(404, "Not found.");
  return { file: functionModule(parts[0]), fn: name(parts[1]) };
}
