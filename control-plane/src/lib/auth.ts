import { cache } from "react";
import { cookies } from "next/headers";
import { db } from "./database";
import { generateId } from "./id";

// Sites on <login>.naru.pub run arbitrary scripts and share naru.pub's cookie
// scope (naru.pub is not a public suffix), so they can set a Domain=naru.pub
// cookie that the control plane would read: a visitor would be signed into the
// site's author's account. Browsers only accept a __Host- cookie that is
// Secure, Path=/ and has no Domain, so no subdomain can set or shadow it.
// __Host- needs Secure, which local development over http can't set; there the
// plain name is used, as before.
const SECURE_COOKIES = process.env.NODE_ENV === "production";
const SESSION_COOKIE_NAME = SECURE_COOKIES
  ? "__Host-auth_session"
  : "auth_session";
// The name sessions were issued under before the __Host- rename. Its
// sessions all expired by 2026-10-31; a leftover cookie, or one a subdomain
// tossed, signs no one in and is cleared.
const LEGACY_SESSION_COOKIE_NAME = "auth_session";
// Sessions live for 30 days and are extended once they pass their halfway
// point, matching Lucia's previous behavior.
const SESSION_EXPIRES_IN_MS = 1000 * 60 * 60 * 24 * 30;
// Lucia set cookies with `expires: false`, i.e. a very long lived cookie. The
// session row in the database is the real source of truth for validity.
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;
// An operator's view as another account (createImpersonationSession) lasts an
// hour and is never extended.
const IMPERSONATION_EXPIRES_IN_MS = 1000 * 60 * 60;

export interface User {
  id: string;
  loginName: string;
  createdAt: Date;
  email: string | null;
  emailVerifiedAt: Date | null;
  discoverable: boolean;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
  fresh: boolean;
  /** The operator's own session, while an operator views as this account. */
  impersonatorSessionId: string | null;
}

export async function createSession(userId: string): Promise<Session> {
  const session = newSession(userId);
  await insertSession(session);
  return session;
}

// A session of userId for the operator signed in with impersonatorSessionId:
// the operator sees the control plane as that account until
// endImpersonation signs them back into their own session.
export async function createImpersonationSession(
  userId: string,
  impersonatorSessionId: string,
): Promise<Session> {
  const session: Session = {
    ...newSession(userId),
    expiresAt: new Date(Date.now() + IMPERSONATION_EXPIRES_IN_MS),
    impersonatorSessionId,
  };
  await insertSession(session);
  return session;
}

function newSession(userId: string): Session {
  const id = generateId(40);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRES_IN_MS);
  return { id, userId, expiresAt, fresh: true, impersonatorSessionId: null };
}

async function insertSession(session: Session): Promise<void> {
  await db
    .insertInto("sessions")
    .values({
      id: session.id,
      user_id: session.userId,
      expires_at: session.expiresAt,
      impersonator_session_id: session.impersonatorSessionId,
    })
    .execute();
}

export async function validateSession(
  sessionId: string,
): Promise<{ user: User; session: Session } | { user: null; session: null }> {
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select([
      "sessions.id as session_id",
      "sessions.expires_at as session_expires_at",
      "sessions.impersonator_session_id",
      "users.id as user_id",
      "users.login_name",
      "users.created_at",
      "users.email",
      "users.email_verified_at",
      "users.discoverable",
    ])
    .where("sessions.id", "=", sessionId)
    .where("users.deleted_at", "is", null)
    .executeTakeFirst();

  if (!row) {
    return { user: null, session: null };
  }

  const expiresAt = new Date(row.session_expires_at);

  // Expired session: clean it up and treat the request as unauthenticated.
  if (Date.now() >= expiresAt.getTime()) {
    await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
    return { user: null, session: null };
  }

  // Extend the session once it passes the halfway point of its lifetime.
  // An operator's view as another account is not extended.
  const impersonatorSessionId = row.impersonator_session_id ?? null;
  let fresh = false;
  let effectiveExpiresAt = expiresAt;
  if (
    !impersonatorSessionId &&
    Date.now() >= expiresAt.getTime() - SESSION_EXPIRES_IN_MS / 2
  ) {
    effectiveExpiresAt = new Date(Date.now() + SESSION_EXPIRES_IN_MS);
    await db
      .updateTable("sessions")
      .set({ expires_at: effectiveExpiresAt })
      .where("id", "=", sessionId)
      .execute();
    fresh = true;
  }

  return {
    session: {
      id: row.session_id,
      userId: row.user_id,
      expiresAt: effectiveExpiresAt,
      fresh,
      impersonatorSessionId,
    },
    user: {
      id: row.user_id,
      loginName: row.login_name,
      createdAt: new Date(row.created_at),
      email: row.email,
      emailVerifiedAt: row.email_verified_at
        ? new Date(row.email_verified_at)
        : null,
      discoverable: row.discoverable,
    },
  };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
}

export async function setSessionCookie(session: Session): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE_COOKIES,
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  });
}

export async function deleteSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE_COOKIES,
    path: "/",
    maxAge: 0,
  });
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;
type AuthResult =
  { user: User; session: Session } | { user: null; session: null };

// Throws while a page renders, like any cookie write.
function clearLegacySessionCookie(cookieStore: CookieStore): void {
  cookieStore.set(LEGACY_SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 0,
  });
}

export const validateRequest = cache(async (): Promise<AuthResult> => {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
  if (SECURE_COOKIES && cookieStore.has(LEGACY_SESSION_COOKIE_NAME)) {
    try {
      clearLegacySessionCookie(cookieStore);
    } catch {}
  }
  if (!sessionId) return { user: null, session: null };

  const result = await validateSession(sessionId);
  // next.js throws when you attempt to set a cookie while rendering a page.
  try {
    if (result.session && result.session.fresh) {
      await setSessionCookie(result.session);
    }
    if (!result.session) {
      await deleteSessionCookie();
    }
  } catch {}
  return result;
});

// Ends an operator's view as another account: drops that session and signs
// the operator back into their own, or signs them out when theirs has ended.
// Returns the operator, or null when signed out.
export async function endImpersonation(session: Session): Promise<User | null> {
  await invalidateSession(session.id);
  const operator = session.impersonatorSessionId
    ? await validateSession(session.impersonatorSessionId)
    : null;
  if (!operator?.session) {
    await deleteSessionCookie();
    return null;
  }
  await setSessionCookie(operator.session);
  return operator.user;
}
