import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "@/lib/db";
import { db } from "@/lib/database";
import { getUserEntitlement, userHasFeature } from "@/lib/entitlements";
import {
  assertSiteOrigin,
  callbackUrl,
  digest,
  sameCallback,
} from "./owner-auth";
import { DataError, name } from "./validation";

// Members: any Naru account, signed in to a site that is not its own. The
// sign-in is the owner's PKCE flow without a registration: the callback only
// has to be a page of the site, and what is granted is the member's own
// identity there, not the owner's collections. A member's id is a row in
// site_members, so a site never learns which account is behind it.
//
// Members need no Naru supporter plan, unless Naru's operators require one of
// a site's members (users.site_members_free off; it is on by default). Then a
// plan (comp, paid, or within the payment grace) is checked at sign-in and on
// every request, so a member whose support ends, or whose site comes to
// require one, loses access without signing out.
//
// A site may also require a verified email (site_member_verified_email): an
// account without one cannot sign in to it as a member, new or returning.
// Requests with a token already issued are not re-checked; verification is
// about who may sign in, and a Naru email cannot become unverified.

/** A member token is used and renewed for up to this long without a request. */
export const MEMBER_TOKEN_SECONDS = 7 * 24 * 60 * 60;
/** However it is used, a member signs in again this long after signing in. */
export const MEMBER_TOKEN_CAP_SECONDS = 30 * 24 * 60 * 60;
const CODE_SECONDS = 60;
/** Member tokens are told apart from owner tokens by this prefix. */
export const MEMBER_TOKEN = /^m\.[A-Za-z0-9_-]{43}$/;
const secret = () => randomBytes(32).toString("base64url");
const denied = () =>
  new DataError(
    401,
    "Member sign-in is invalid, expired or revoked.",
    "AUTH_REQUIRED",
  );

const supporterRequired = () =>
  new DataError(
    403,
    "Members of Naru sites need a Naru supporter plan.",
    "ACCESS_DENIED",
  );

const emailRequired = () =>
  new DataError(
    403,
    "This site requires members to have a verified email on Naru.",
    "ACCESS_DENIED",
  );

/** Whether the account has verified an email on Naru. */
async function emailVerified(tx: Kysely<DB>, userId: string) {
  const user = await tx
    .selectFrom("users")
    .select(["email", "email_verified_at"])
    .where("id", "=", userId)
    .executeTakeFirst();
  return Boolean(user?.email && user.email_verified_at);
}

/** Whether an account may be a member of the site: the site is free to join, or it supports Naru. */
async function mayJoin(tx: Kysely<DB>, userId: string, siteUserId: string) {
  const site = await tx
    .selectFrom("users")
    .select("site_members_free")
    .where("id", "=", siteUserId)
    .executeTakeFirst();
  return (
    site?.site_members_free === true ||
    (await getUserEntitlement(userId, tx)).isSupporter
  );
}

export type MemberSignInInput = ReturnType<typeof memberSignInInput>;
export function memberSignInInput(body: Record<string, unknown>) {
  const text = (value: unknown, max: number) => {
    if (typeof value !== "string" || !value || value.length > max)
      throw new DataError(400, "Invalid sign-in request.");
    return value;
  };
  const challenge = text(body.challenge, 43);
  const state = text(body.state, 128);
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(state)
  )
    throw new DataError(400, "S256 PKCE challenge and random state required.");
  return {
    site: name(body.site),
    redirectUri: callbackUrl(body.redirectUri).href,
    challenge,
    state,
  };
}

/**
 * The site a sign-in is for, if it can have members: it exists, has the
 * database, and the callback is one of its pages. Messages are for the
 * sign-in page, which is where they are read.
 */
async function siteFor(tx: Kysely<DB>, input: MemberSignInInput) {
  const site = await tx
    .selectFrom("users")
    .select([
      "id",
      "login_name",
      "site_member_admission",
      "site_member_verified_email",
    ])
    .where("login_name", "=", input.site)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!site || !(await userHasFeature(site.id, "database", tx)))
    throw new DataError(404, `${input.site} 사이트는 회원을 받지 않습니다.`);
  try {
    await assertSiteOrigin(tx, site.id, input.redirectUri);
  } catch {
    throw new DataError(
      403,
      `로그인을 요청한 페이지가 ${input.site} 사이트의 페이지가 아닙니다: ${input.redirectUri}`,
    );
  }
  return site;
}

/**
 * What the sign-in page shows: the site, whether this account can join it
 * under the current setting, and whether its notifications reach the Naru
 * app: ticked unless the account turned them off.
 */
export async function previewMemberSignIn(
  userId: string,
  input: MemberSignInInput,
) {
  const site = await siteFor(db, input);
  const member = await db
    .selectFrom("site_members")
    .select("status")
    .where("site_user_id", "=", site.id)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (member?.status === "banned") throw membershipDenied("banned");
  if (!member && site.site_member_admission === "closed")
    throw new DataError(
      403,
      "이 사이트는 신규 회원 가입을 받지 않습니다.",
      "ACCESS_DENIED",
    );
  const consent = await db
    .selectFrom("app_site_consents")
    .select("state")
    .where("user_id", "=", userId)
    .where("site_user_id", "=", site.id)
    .executeTakeFirst();
  return {
    site: site.login_name,
    notifications: consent?.state !== "muted",
    mayJoin: await mayJoin(db, userId, site.id),
    needsVerifiedEmail:
      site.site_member_verified_email && !(await emailVerified(db, userId)),
  };
}

/**
 * The member's approval: a single-use code for the page that asked. With
 * `notifications`, what the sign-in page's box said: whether the site's
 * notifications reach the account's Naru app (app_site_consents, as the
 * app's own switch sets it), so its first one is pushed without asking.
 */
export async function approveMemberSignIn(
  userId: string,
  sessionId: string,
  input: MemberSignInInput,
  notifications?: boolean,
) {
  return db.transaction().execute(async (tx) => {
    const site = await siteFor(tx, input);
    const { site_member_admission: admission } = await tx
      .selectFrom("users")
      .select("site_member_admission")
      .where("id", "=", site.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const existing = await tx
      .selectFrom("site_members")
      .select(["id", "status"])
      .where("site_user_id", "=", site.id)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (existing?.status === "banned") throw membershipDenied("banned");
    if (!existing && admission === "closed")
      throw new DataError(
        403,
        "This site is closed to new members.",
        "ACCESS_DENIED",
      );
    if (!(await mayJoin(tx, userId, site.id))) throw supporterRequired();
    if (site.site_member_verified_email && !(await emailVerified(tx, userId)))
      throw emailRequired();
    const session = await tx
      .selectFrom("sessions")
      .select("id")
      .where("id", "=", sessionId)
      .where("user_id", "=", userId)
      .where("expires_at", ">", new Date())
      .executeTakeFirst();
    if (!session) throw denied();
    await tx
      .insertInto("site_members")
      .values({
        site_user_id: site.id,
        user_id: userId,
        status: admission === "approval" ? "pending" : "approved",
      })
      .onConflict((conflict) =>
        conflict.columns(["site_user_id", "user_id"]).doNothing(),
      )
      .execute();
    const member = await tx
      .selectFrom("site_members")
      .select("id")
      .where("site_user_id", "=", site.id)
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    if (notifications !== undefined) {
      const state = notifications ? "allowed" : "muted";
      await tx
        .insertInto("app_site_consents")
        .values({ user_id: userId, site_user_id: site.id, state })
        .onConflict((conflict) =>
          conflict
            .columns(["user_id", "site_user_id"])
            .doUpdateSet({ state, updated_at: new Date() }),
        )
        .execute();
      // Muting forgets what the site sent, as in the app (app-api/inbox.ts).
      if (!notifications)
        await tx
          .deleteFrom("app_notifications")
          .where("user_id", "=", userId)
          .where("site_user_id", "=", site.id)
          .execute();
    }
    await tx
      .deleteFrom("site_member_codes")
      .where("expires_at", "<=", new Date())
      .execute();
    const pending = await tx
      .selectFrom("site_member_codes")
      .select("hash")
      .where("member_id", "=", member.id)
      .execute();
    if (pending.length >= 20)
      throw new DataError(
        429,
        "Too many pending sign-ins. Try again in a minute.",
      );
    const code = secret();
    await tx
      .insertInto("site_member_codes")
      .values({
        hash: digest(code),
        member_id: member.id,
        session_id: sessionId,
        redirect_uri: input.redirectUri,
        challenge: input.challenge,
        expires_at: new Date(Date.now() + CODE_SECONDS * 1000),
      })
      .execute();
    const redirect = new URL(input.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", input.state);
    return { redirect: redirect.href };
  });
}

/** The page trades its code for a member token, from the page's origin. */
export async function exchangeMemberCode(
  body: Record<string, unknown>,
  origin: string | null,
) {
  const text = (value: unknown) => {
    if (typeof value !== "string" || !value || value.length > 2048)
      throw denied();
    return value;
  };
  const code = text(body.code);
  const verifier = text(body.verifier);
  const redirectUri = text(body.redirectUri);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw denied();
  return db.transaction().execute(async (tx) => {
    // Deleting it is what makes it single-use, also across processes.
    const grant = await tx
      .deleteFrom("site_member_codes")
      .where("hash", "=", digest(code))
      .where("expires_at", ">", new Date())
      .returningAll()
      .executeTakeFirst();
    if (
      !grant ||
      grant.challenge !== digest(verifier) ||
      !sameCallback(grant.redirect_uri, redirectUri) ||
      origin !== new URL(grant.redirect_uri).origin
    )
      throw denied();
    const member = await tx
      .selectFrom("site_members as m")
      .innerJoin("sessions as s", "s.user_id", "m.user_id")
      .select([
        "m.id",
        "m.site_user_id",
        "m.user_id",
        "m.status",
        "s.expires_at",
      ])
      .where("m.id", "=", grant.member_id)
      .where("s.id", "=", grant.session_id)
      .where("s.expires_at", ">", new Date())
      .executeTakeFirst();
    if (!member) throw denied();
    if (member.status === "banned") throw membershipDenied("banned");
    await assertSiteOrigin(tx, member.site_user_id, grant.redirect_uri);
    if (!(await mayJoin(tx, member.user_id, member.site_user_id)))
      throw supporterRequired();
    await tx
      .deleteFrom("site_member_tokens")
      .where("expires_at", "<=", new Date())
      .execute();
    const live = await tx
      .selectFrom("site_member_tokens")
      .select("hash")
      .where("member_id", "=", member.id)
      .execute();
    if (live.length >= 20)
      throw new DataError(
        429,
        "Too many active sign-ins for this member. Sign out elsewhere first.",
      );
    const expiresAt = Math.min(
      Date.now() + MEMBER_TOKEN_SECONDS * 1000,
      new Date(member.expires_at).getTime(),
    );
    const expiresIn = Math.floor((expiresAt - Date.now()) / 1000);
    if (expiresIn <= 0) throw denied();
    const accessToken = `m.${secret()}`;
    await tx
      .insertInto("site_member_tokens")
      .values({
        hash: digest(accessToken),
        member_id: member.id,
        session_id: grant.session_id,
        origin: new URL(grant.redirect_uri).origin,
        expires_at: new Date(expiresAt),
      })
      .execute();
    return { accessToken, expiresIn, expiresAt, memberId: member.id };
  });
}

/**
 * The member behind a token, for a request to `siteUserId`'s site. Renews
 * the token the way an owner token is renewed: only once past the halfway
 * mark, never past the cap or the Naru session, reporting the new expiry in
 * `bearer.expiresAt`.
 */
export async function memberIdentity(
  tx: Kysely<DB>,
  siteUserId: string,
  bearer: { token: string; origin: string | null; expiresAt?: number },
) {
  if (!MEMBER_TOKEN.test(bearer.token)) throw denied();
  const grant = await tx
    .selectFrom("site_member_tokens as t")
    .innerJoin("site_members as m", "m.id", "t.member_id")
    .innerJoin("sessions as s", "s.id", "t.session_id")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select([
      "m.id",
      "m.user_id",
      "m.status",
      "t.origin",
      "t.issued_at",
      "t.expires_at",
      "s.expires_at as session_expires_at",
    ])
    .where("t.hash", "=", digest(bearer.token))
    .where("m.site_user_id", "=", siteUserId)
    .where("t.expires_at", ">", new Date())
    .where("s.expires_at", ">", new Date())
    .where("u.deleted_at", "is", null)
    .executeTakeFirst();
  if (!grant || bearer.origin !== grant.origin) throw denied();
  await assertSiteOrigin(tx, siteUserId, grant.origin);
  if (!(await mayJoin(tx, grant.user_id, siteUserId)))
    throw supporterRequired();
  const current = new Date(grant.expires_at).getTime();
  if (Date.now() >= current - (MEMBER_TOKEN_SECONDS * 1000) / 2) {
    const renewed = Math.max(
      current,
      Math.min(
        Date.now() + MEMBER_TOKEN_SECONDS * 1000,
        new Date(grant.issued_at).getTime() + MEMBER_TOKEN_CAP_SECONDS * 1000,
        new Date(grant.session_expires_at).getTime(),
      ),
    );
    if (renewed !== current) {
      await tx
        .updateTable("site_member_tokens")
        .set({ expires_at: new Date(renewed) })
        .where("hash", "=", digest(bearer.token))
        .execute();
      bearer.expiresAt = renewed;
    }
  }
  return { id: grant.id, status: grant.status };
}

/** Signing out: idempotent, and only from the page's own origin. */
export async function revokeMemberToken(token: string, origin: string | null) {
  if (!MEMBER_TOKEN.test(token)) throw denied();
  const grant = await db
    .selectFrom("site_member_tokens")
    .select("origin")
    .where("hash", "=", digest(token))
    .executeTakeFirst();
  if (!grant) return;
  if (origin !== grant.origin) throw denied();
  await db
    .deleteFrom("site_member_tokens")
    .where("hash", "=", digest(token))
    .execute();
}

export type MembershipStatus = "pending" | "approved" | "banned";
export type AdmissionMode = "open" | "approval" | "closed";

/**
 * A member's request refused for their standing: `details.membership` tells
 * the page which, so it can show an approval screen without asking again.
 */
function membershipDenied(status: MembershipStatus) {
  return new DataError(
    403,
    status === "banned"
      ? "Membership is banned."
      : "Membership is awaiting approval.",
    "ACCESS_DENIED",
    { membership: status },
  );
}

/** All authenticated data, function and media requests require approval. */
export async function memberScope(
  tx: Kysely<DB>,
  siteUserId: string,
  bearer: { token: string; origin: string | null; expiresAt?: number },
) {
  const member = await memberIdentity(tx, siteUserId, bearer);
  if (member.status !== "approved") throw membershipDenied(member.status);
  return member.id;
}
