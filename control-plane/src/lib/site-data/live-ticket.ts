// A member's pass onto a site's live connection (edge/src/live.ts). Browsers
// cannot send an Authorization header when they open a WebSocket, so a member
// trades their token here, at the control plane, for this: signed with the
// secret the control plane and the edge Worker share, naming the site and the
// member, and good for a minute, only to open a connection. No Node-only
// imports: the edge Worker checks what the control plane signs.

const TICKET_MS = 60_000;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromBase64url = (text: string) =>
  Uint8Array.from(
    atob(text.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );

async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`naru-live-ticket:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signLiveTicket(
  secret: string,
  site: string,
  member: string,
  now = Date.now(),
) {
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({ s: site, m: member, e: now + TICKET_MS }),
    ),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await key(secret),
      new TextEncoder().encode(payload),
    ),
  );
  return `${payload}.${base64url(signature)}`;
}

/** The member a ticket for `site` names, or null if it is not one, or expired. */
export async function verifyLiveTicket(
  secret: string,
  site: string,
  ticket: string,
  now = Date.now(),
): Promise<string | null> {
  const match = /^([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!match) return null;
  try {
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await key(secret),
        fromBase64url(match[2]),
        new TextEncoder().encode(match[1]),
      ))
    )
      return null;
    const claims = JSON.parse(
      new TextDecoder().decode(fromBase64url(match[1])),
    );
    return claims.s === site &&
      typeof claims.m === "string" &&
      typeof claims.e === "number" &&
      now < claims.e
      ? claims.m
      : null;
  } catch {
    return null;
  }
}

/**
 * Who an owner's ticket is for: not a member ID (those are UUIDs), so the
 * Worker passes the connection on as the owner's.
 */
export const OWNER_TICKET = "~owner";
