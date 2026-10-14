import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

// Salted PBKDF2-SHA256, for ctx.password and documents' write secrets.
export const PASSWORD_ITERATIONS = 20_000;
const PASSWORD =
  /^pbkdf2-sha256\$(\d{1,7})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256");
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** Whether `password` produced `stored`; null when `stored` is not such a hash. */
export function verifyPassword(password: string, stored: unknown) {
  const match = typeof stored === "string" ? PASSWORD.exec(stored) : null;
  if (!match || Number(match[1]) > 1_000_000) return null;
  const expected = Buffer.from(match[3], "base64url");
  const actual = pbkdf2Sync(
    password,
    Buffer.from(match[2], "base64url"),
    Number(match[1]),
    expected.length,
    "sha256",
  );
  return timingSafeEqual(actual, expected);
}
