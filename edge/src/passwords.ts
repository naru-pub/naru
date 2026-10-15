import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

// Documents' write secrets, as salted PBKDF2-SHA256 in the PHC string format
// that password libraries share: $pbkdf2-sha256$i=<iterations>$<salt>$<hash>,
// salt and hash in standard base64 without padding. The method is in the
// string, so a stronger one can be added beside it later.
export const PASSWORD_ITERATIONS = 20_000;
const PASSWORD =
  /^\$pbkdf2-sha256\$i=(\d{1,7})\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;
const base64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, "sha256");
  return `$pbkdf2-sha256$i=${PASSWORD_ITERATIONS}$${base64(salt)}$${base64(hash)}`;
}

/** Whether `password` produced `stored`; null when `stored` is not such a hash. */
export function verifyPassword(password: string, stored: unknown) {
  const match = typeof stored === "string" ? PASSWORD.exec(stored) : null;
  if (!match || Number(match[1]) > 1_000_000) return null;
  const expected = Buffer.from(match[3], "base64");
  const actual = pbkdf2Sync(
    password,
    Buffer.from(match[2], "base64"),
    Number(match[1]),
    expected.length,
    "sha256",
  );
  return timingSafeEqual(actual, expected);
}
