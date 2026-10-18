import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/database";
import { DataError } from "@/lib/site-data/validation";

// Signing in to the Naru app (docs/design/naru-app.md). The app opens
// /app/authorize in the system browser (ASWebAuthenticationSession, a Custom
// Tab), where the person signs in to naru.pub however naru.pub signs people in
// — so TOTP, passkeys and other methods added there need no app release — and
// approves the app. Naru redirects back with a one-time code, which the app
// exchanges with its PKCE verifier for a token. The redirect is one of:
//
// - https://naru.pub/app/callback (APP_HTTPS_CALLBACK): the iOS and macOS app,
//   whose ASWebAuthenticationSession takes it because naru.pub's
//   apple-app-site-association names the app, and the Android app, whose
//   Auth Tab takes it because assetlinks.json does (RFC 8252 §7.2: no other
//   app can claim it);
// - pub.naru:/auth (APP_REDIRECT_URI, RFC 8252 §7.1's private-use scheme, the
//   reversed domain): Android without an Auth Tab, and either app against a
//   development server.
//   Another app may register the scheme and see the redirect; PKCE makes a
//   seen code useless without the verifier, which never leaves the app that
//   started the sign-in.
//
// The token lasts until revoked: sign-out in the app, or deleting the account.

export const APP_CLIENTS = ["ios", "macos", "android"] as const;
export type AppClient = (typeof APP_CLIENTS)[number];
export const APP_REDIRECT_URI = "pub.naru:/auth";

/** naru.pub's own page the Apple app's sign-in returns to. */
export function appHttpsCallback() {
  const origin =
    process.env.SITE_DATA_CONTROL_PLANE_ORIGIN ||
    `https://${process.env.NEXT_PUBLIC_DOMAIN || "naru.pub"}`;
  return new URL("/app/callback", origin).href;
}

const appRedirects = () => [APP_REDIRECT_URI, appHttpsCallback()];
const CODE_SECONDS = 10 * 60;
/** last_used_at is written at most this often per token. */
const TOUCH_SECONDS = 60 * 60;

export interface AppUser {
  id: string;
  loginName: string;
  tokenId: string;
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const secret = () => randomBytes(32).toString("base64url");

export type AuthorizeInput = ReturnType<typeof authorizeInput>;

/** The query /app/authorize was opened with, or a DataError worded for that page. */
export function authorizeInput(params: Record<string, unknown>) {
  const client = params.client;
  if (!APP_CLIENTS.includes(client as AppClient))
    throw new DataError(400, "알 수 없는 앱입니다.");
  const redirectUri = params.redirect_uri;
  if (typeof redirectUri !== "string" || !appRedirects().includes(redirectUri))
    throw new DataError(400, "앱으로 돌아갈 주소가 올바르지 않습니다.");
  const challenge = params.code_challenge;
  const state = params.state;
  if (
    params.code_challenge_method !== "S256" ||
    typeof challenge !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    typeof state !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(state)
  )
    throw new DataError(400, "로그인 요청이 올바르지 않습니다.");
  return {
    client: client as AppClient,
    redirectUri,
    challenge,
    state,
  };
}

/** The approved sign-in's redirect back to the app, with a fresh code. */
export async function approveAuthorization(
  userId: string,
  input: AuthorizeInput,
) {
  const code = secret();
  await db
    .insertInto("app_auth_codes")
    .values({
      hash: digest(code),
      user_id: userId,
      client: input.client,
      challenge: input.challenge,
      redirect_uri: input.redirectUri,
      expires_at: new Date(Date.now() + CODE_SECONDS * 1000),
    })
    .execute();
  return callback(input.redirectUri, input.state, { code });
}

function callback(redirectUri: string, state: string, params: Record<string, string>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  url.searchParams.set("state", state);
  return url.href;
}

/** POST /token: a code and its verifier, for a token. A code works once. */
export async function exchangeCode(body: Record<string, unknown>) {
  const { code, verifier, redirectUri } = body;
  const failed = () =>
    new DataError(400, "로그인을 마치지 못했습니다. 다시 시도해 주세요.");
  if (
    typeof code !== "string" ||
    typeof verifier !== "string" ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
    typeof redirectUri !== "string" ||
    !appRedirects().includes(redirectUri)
  )
    throw failed();
  // Spent before it is checked, in its own statement: a wrong verifier must
  // not leave the code for another guess.
  const grant = await db
    .deleteFrom("app_auth_codes")
    .where("hash", "=", digest(code))
    .returning(["user_id", "client", "challenge", "redirect_uri", "expires_at"])
    .executeTakeFirst();
  if (
    !grant ||
    new Date(grant.expires_at).getTime() < Date.now() ||
    grant.redirect_uri !== redirectUri ||
    !same(digest(verifier), grant.challenge)
  )
    throw failed();
  return db.transaction().execute(async (tx) => {
    const user = await tx
      .selectFrom("users")
      .select(["id", "login_name"])
      .where("id", "=", grant.user_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!user) throw failed();
    const token = `a.${secret()}`;
    await tx
      .insertInto("app_tokens")
      .values({ user_id: user.id, hash: digest(token), client: grant.client })
      .execute();
    return { token, account: { loginName: user.login_name } };
  });
}

function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The account behind an app token, or null when it is unknown or revoked. */
export async function appTokenUser(token: string): Promise<AppUser | null> {
  const row = await db
    .selectFrom("app_tokens")
    .innerJoin("users", "users.id", "app_tokens.user_id")
    .select([
      "app_tokens.id as token_id",
      "app_tokens.last_used_at",
      "users.id as user_id",
      "users.login_name",
    ])
    .where("app_tokens.hash", "=", digest(token))
    .where("users.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  if (Date.now() - new Date(row.last_used_at).getTime() > TOUCH_SECONDS * 1000)
    await db
      .updateTable("app_tokens")
      .set({ last_used_at: new Date() })
      .where("id", "=", row.token_id)
      .execute();
  return { id: row.user_id, loginName: row.login_name, tokenId: row.token_id };
}

/** Sign-out: the token and the devices it registered. */
export async function revokeAppToken(tokenId: string) {
  await db.deleteFrom("app_tokens").where("id", "=", tokenId).execute();
}
