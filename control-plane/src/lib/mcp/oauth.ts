import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { userHasFeature } from "@/lib/entitlements";
import { parseUuid } from "@/lib/uuid";
import { SCOPES, type Scope } from "./scopes";

// Signing in to Naru MCP (docs/design/naru-mcp.md) with OAuth 2.1, the way
// the MCP authorization spec asks: the app finds this server from /mcp's 401
// (RFC 9728 protected resource metadata, then RFC 8414 server metadata),
// registers itself (RFC 7591), sends the person to /mcp/authorize, where they
// sign in to naru.pub and approve it, and exchanges the code with its PKCE
// verifier for an access token and a refresh token.
//
// Apps are public clients: there is no client secret to keep, and PKCE binds
// each code to the app that started the sign-in. The access token lasts an
// hour; each refresh replaces both tokens, and a connection left unused for
// REFRESH_IDLE_DAYS needs a new sign-in. Revoking a connection on /account
// deletes its grant, which ends both tokens at once.

const CODE_SECONDS = 10 * 60;
const ACCESS_SECONDS = 60 * 60;
const REFRESH_IDLE_DAYS = 30;
/** last_used_at is written at most this often per grant. */
const TOUCH_SECONDS = 60 * 60;
/** Registrations accepted per hour across Naru, since anyone may register. */
const REGISTRATIONS_PER_HOUR = 500;
const MAX_REDIRECT_URIS = 5;
const MAX_CLIENT_NAME = 100;

/** naru.pub, the issuer and the MCP server's origin. */
export function naruOrigin() {
  return (
    process.env.SITE_DATA_CONTROL_PLANE_ORIGIN ||
    `https://${process.env.NEXT_PUBLIC_DOMAIN || "naru.pub"}`
  ).replace(/\/+$/, "");
}

/** The MCP server's URL, which tokens are issued for (RFC 8707). */
export const mcpResource = () => `${naruOrigin()}/mcp`;

export const resourceMetadataUrl = () =>
  `${naruOrigin()}/.well-known/oauth-protected-resource/mcp`;

/** A reason /mcp/authorize can't go on, worded for the person on it. */
export class ConsentError extends Error {}

/** An OAuth error, as the token and registration endpoints answer it. */
export class OAuthError extends Error {
  constructor(
    public status: number,
    public error: string,
    description: string,
  ) {
    super(description);
  }
}

export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [naruOrigin()],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Naru",
    resource_documentation: `${naruOrigin()}/docs/mcp`,
  };
}

export function authorizationServerMetadata() {
  const origin = naruOrigin();
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/mcp/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/docs/mcp`,
  };
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const secret = () => randomBytes(32).toString("base64url");

function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Schemes a page may never be sent to: approving a sign-in on naru.pub
// navigates to the redirect, so these would run in naru.pub's own page.
const UNSAFE_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where an app may ask to be sent back to: https anywhere, http only to this
 * machine (RFC 8252 §7.3, desktop apps), or the app's own scheme (§7.1).
 */
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return !!url.hostname;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return (
    /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) &&
    !UNSAFE_SCHEMES.has(url.protocol)
  );
}

/** The host a redirect leads to, as the consent page shows it. */
export function redirectHost(redirectUri: string) {
  const url = new URL(redirectUri);
  return url.host || url.protocol.replace(/:$/, "");
}

/** POST /api/mcp/oauth/register (RFC 7591). */
export async function registerClient(body: unknown) {
  const metadata =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!metadata)
    throw new OAuthError(
      400,
      "invalid_client_metadata",
      "Expected a JSON object.",
    );
  const redirectUris = metadata.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    !redirectUris.length ||
    redirectUris.length > MAX_REDIRECT_URIS ||
    !redirectUris.every(validRedirectUri)
  )
    throw new OAuthError(
      400,
      "invalid_redirect_uri",
      `redirect_uris takes 1-${MAX_REDIRECT_URIS} https URLs, loopback http URLs or private-use scheme URLs.`,
    );
  const grantTypes = metadata.grant_types;
  if (
    grantTypes !== undefined &&
    (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code"))
  )
    throw new OAuthError(
      400,
      "invalid_client_metadata",
      "grant_types must include authorization_code.",
    );
  const responseTypes = metadata.response_types;
  if (
    responseTypes !== undefined &&
    (!Array.isArray(responseTypes) || !responseTypes.includes("code"))
  )
    throw new OAuthError(
      400,
      "invalid_client_metadata",
      "response_types must include code.",
    );
  const name =
    typeof metadata.client_name === "string" && metadata.client_name.trim()
      ? metadata.client_name.trim().slice(0, MAX_CLIENT_NAME)
      : "MCP 앱";

  // Registrations no sign-in followed are dropped after a day, so anyone
  // registering keeps at most a day's worth.
  await db
    .deleteFrom("mcp_clients")
    .where("created_at", "<", sql<Date>`now() - interval '1 day'`)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("mcp_grants")
            .select("mcp_grants.id")
            .whereRef("mcp_grants.client_id", "=", "mcp_clients.id"),
        ),
      ),
    )
    .execute();
  const recent = await db
    .selectFrom("mcp_clients")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("created_at", ">", sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirstOrThrow();
  if (recent.count >= REGISTRATIONS_PER_HOUR)
    throw new OAuthError(
      429,
      "temporarily_unavailable",
      "Too many registrations. Try again later.",
    );

  const client = await db
    .insertInto("mcp_clients")
    .values({ name, redirect_uris: redirectUris })
    .returning(["id", "created_at"])
    .executeTakeFirstOrThrow();
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(
      new Date(client.created_at).getTime() / 1000,
    ),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** The scopes a request names, all of them when it names none. */
export function parseScope(value: unknown): Scope[] {
  if (value === undefined || value === null || value === "") return [...SCOPES];
  if (typeof value !== "string")
    throw new ConsentError("알 수 없는 권한입니다.");
  const asked = value.split(" ").filter(Boolean);
  if (!asked.every((scope) => (SCOPES as readonly string[]).includes(scope)))
    throw new ConsentError("알 수 없는 권한입니다.");
  return SCOPES.filter((scope) => asked.includes(scope));
}

export type AuthorizeRequest = Awaited<ReturnType<typeof authorizeRequest>>;

/**
 * The query /mcp/authorize was opened with, checked against the app's
 * registration. Throws an Error worded for that page: nothing is sent back to
 * a redirect until it is known to be the app's own.
 */
export async function authorizeRequest(params: Record<string, unknown>) {
  const clientId = parseUuid(params.client_id);
  const client = clientId
    ? await db
        .selectFrom("mcp_clients")
        .select(["id", "name", "redirect_uris"])
        .where("id", "=", clientId)
        .executeTakeFirst()
    : undefined;
  if (!client)
    throw new ConsentError(
      "등록되지 않은 앱입니다. 앱에서 다시 연결해 주세요.",
    );
  const redirectUri =
    params.redirect_uri === undefined && client.redirect_uris.length === 1
      ? client.redirect_uris[0]
      : params.redirect_uri;
  if (
    typeof redirectUri !== "string" ||
    !client.redirect_uris.includes(redirectUri)
  )
    throw new ConsentError("앱으로 돌아갈 주소가 등록된 주소와 다릅니다.");
  const challenge = params.code_challenge;
  const state = params.state;
  const resource = params.resource;
  if (
    params.response_type !== "code" ||
    params.code_challenge_method !== "S256" ||
    typeof challenge !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    (state !== undefined &&
      (typeof state !== "string" || state.length > 1000)) ||
    (resource !== undefined &&
      (typeof resource !== "string" ||
        resource.replace(/\/+$/, "") !== mcpResource()))
  )
    throw new ConsentError(
      "연결 요청이 올바르지 않습니다. 앱에서 다시 연결해 주세요.",
    );
  let scopes: Scope[];
  try {
    scopes = parseScope(params.scope);
  } catch {
    throw new ConsentError("앱이 알 수 없는 권한을 요청했습니다.");
  }
  return {
    client: { id: client.id, name: client.name },
    redirectUri,
    challenge,
    state: typeof state === "string" ? state : null,
    scopes,
  };
}

function callback(
  input: { redirectUri: string; state: string | null },
  params: Record<string, string>,
) {
  const url = new URL(input.redirectUri);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  if (input.state !== null) url.searchParams.set("state", input.state);
  url.searchParams.set("iss", naruOrigin());
  return url.href;
}

/** The redirect that tells the app the person declined. */
export const deniedRedirect = (input: AuthorizeRequest) =>
  callback(input, { error: "access_denied" });

/**
 * The approved sign-in's redirect back to the app, with a fresh code for the
 * scopes the person kept, which must be among those the app asked for.
 */
export async function approveAuthorization(
  userId: string,
  input: AuthorizeRequest,
  scopes: Scope[],
) {
  if (!scopes.length || !scopes.every((scope) => input.scopes.includes(scope)))
    throw new ConsentError("허용할 권한을 골라 주세요.");
  if (!(await userHasFeature(userId, "mcp")))
    throw new ConsentError("MCP 연결은 후원 플랜 기능입니다.");
  const code = secret();
  await db
    .insertInto("mcp_auth_codes")
    .values({
      hash: digest(code),
      client_id: input.client.id,
      user_id: userId,
      challenge: input.challenge,
      redirect_uri: input.redirectUri,
      scope: scopes.join(" "),
      expires_at: new Date(Date.now() + CODE_SECONDS * 1000),
    })
    .execute();
  return callback(input, { code });
}

function issue() {
  const access = `m.${secret()}`;
  const refresh = `mr.${secret()}`;
  return {
    access,
    refresh,
    columns: {
      access_hash: digest(access),
      access_expires_at: new Date(Date.now() + ACCESS_SECONDS * 1000),
      refresh_hash: digest(refresh),
    },
  };
}

const tokenResponse = (tokens: ReturnType<typeof issue>, scope: string) => ({
  access_token: tokens.access,
  token_type: "Bearer",
  expires_in: ACCESS_SECONDS,
  refresh_token: tokens.refresh,
  scope,
});

const invalidGrant = () =>
  new OAuthError(
    400,
    "invalid_grant",
    "The grant is invalid, expired or revoked.",
  );

/** POST /api/mcp/oauth/token: both grant types, from the form's fields. */
export async function exchangeToken(form: URLSearchParams) {
  const grantType = form.get("grant_type");
  const clientId = parseUuid(form.get("client_id"));
  if (!clientId)
    throw new OAuthError(401, "invalid_client", "client_id is required.");
  if (grantType === "authorization_code") return exchangeCode(form, clientId);
  if (grantType === "refresh_token") return refresh(form, clientId);
  throw new OAuthError(
    400,
    "unsupported_grant_type",
    "grant_type is authorization_code or refresh_token.",
  );
}

async function exchangeCode(form: URLSearchParams, clientId: string) {
  const code = form.get("code");
  const verifier = form.get("code_verifier");
  const redirectUri = form.get("redirect_uri");
  if (!code || !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
    throw new OAuthError(
      400,
      "invalid_request",
      "code and a valid code_verifier are required.",
    );
  // Spent before it is checked, in its own statement: a wrong verifier must
  // not leave the code for another guess.
  const grant = await db
    .deleteFrom("mcp_auth_codes")
    .where("hash", "=", digest(code))
    .returning([
      "user_id",
      "client_id",
      "challenge",
      "redirect_uri",
      "scope",
      "expires_at",
    ])
    .executeTakeFirst();
  if (
    !grant ||
    new Date(grant.expires_at).getTime() < Date.now() ||
    grant.client_id !== clientId ||
    (redirectUri !== null && grant.redirect_uri !== redirectUri) ||
    !same(digest(verifier), grant.challenge)
  )
    throw invalidGrant();
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", grant.user_id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!user) throw invalidGrant();
  const tokens = issue();
  await db
    .insertInto("mcp_grants")
    .values({
      user_id: user.id,
      client_id: clientId,
      scope: grant.scope,
      ...tokens.columns,
    })
    .execute();
  return tokenResponse(tokens, grant.scope);
}

async function refresh(form: URLSearchParams, clientId: string) {
  const token = form.get("refresh_token");
  if (!token)
    throw new OAuthError(400, "invalid_request", "refresh_token is required.");
  const hash = digest(token);
  // A refresh token already replaced, presented again: either the app or
  // someone who copied its token used it first, and Naru cannot tell which.
  // End the connection, so whoever holds the newer token loses it too; the
  // person connects again (OAuth 2.1 §4.3.1).
  const replayed = await db
    .deleteFrom("mcp_grants")
    .where("previous_refresh_hash", "=", hash)
    .returning("id")
    .executeTakeFirst();
  if (replayed) throw invalidGrant();
  const tokens = issue();
  // One statement, matched on the old hash: two refreshes with the same token
  // cannot both win, and the loser's token is already gone.
  const grant = await db
    .updateTable("mcp_grants")
    .set({
      ...tokens.columns,
      previous_refresh_hash: hash,
      last_used_at: new Date(),
    })
    .where("refresh_hash", "=", hash)
    .where("client_id", "=", clientId)
    .where(
      "last_used_at",
      ">",
      sql<Date>`now() - make_interval(days => ${REFRESH_IDLE_DAYS})`,
    )
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom("users")
          .select("users.id")
          .whereRef("users.id", "=", "mcp_grants.user_id")
          .where("users.deleted_at", "is", null),
      ),
    )
    .returning("scope")
    .executeTakeFirst();
  if (!grant) throw invalidGrant();
  return tokenResponse(tokens, grant.scope);
}

export interface McpGrant {
  grantId: string;
  userId: string;
  loginName: string;
  clientId: string;
  scopes: Scope[];
  expiresAt: number;
}

/** The connection an access token belongs to, or null when it is not valid. */
export async function grantForAccessToken(
  token: string,
): Promise<McpGrant | null> {
  if (!/^m\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await db
    .selectFrom("mcp_grants")
    .innerJoin("users", "users.id", "mcp_grants.user_id")
    .select([
      "mcp_grants.id",
      "mcp_grants.client_id",
      "mcp_grants.scope",
      "mcp_grants.access_expires_at",
      "mcp_grants.last_used_at",
      "users.id as user_id",
      "users.login_name",
    ])
    .where("mcp_grants.access_hash", "=", digest(token))
    .where("mcp_grants.access_expires_at", ">", new Date())
    .where("users.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  if (Date.now() - new Date(row.last_used_at).getTime() > TOUCH_SECONDS * 1000)
    await db
      .updateTable("mcp_grants")
      .set({ last_used_at: new Date() })
      .where("id", "=", row.id)
      .execute();
  return {
    grantId: row.id,
    userId: String(row.user_id),
    loginName: row.login_name,
    clientId: row.client_id,
    scopes: parseScope(row.scope),
    expiresAt: Math.floor(new Date(row.access_expires_at).getTime() / 1000),
  };
}

/** An account's connections, newest first, for /account. */
export async function listGrants(userId: string) {
  const rows = await db
    .selectFrom("mcp_grants")
    .innerJoin("mcp_clients", "mcp_clients.id", "mcp_grants.client_id")
    .select([
      "mcp_grants.id",
      "mcp_grants.scope",
      "mcp_grants.created_at",
      "mcp_grants.last_used_at",
      "mcp_clients.name",
      "mcp_clients.redirect_uris",
    ])
    .where("mcp_grants.user_id", "=", userId)
    .orderBy("mcp_grants.id", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    host: redirectHost(row.redirect_uris[0]),
    scopes: parseScope(row.scope),
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: new Date(row.last_used_at).toISOString(),
  }));
}

/** Ends a connection: both its tokens stop working. */
export async function revokeGrant(userId: string, grantId: string) {
  await db
    .deleteFrom("mcp_grants")
    .where("id", "=", grantId)
    .where("user_id", "=", userId)
    .execute();
}
