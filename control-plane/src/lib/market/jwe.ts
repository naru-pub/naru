import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "crypto";

// Toss's ENCRYPTION security mode for the payout and seller APIs: a request
// body goes as a compact JWE, direct encryption (alg dir) under the 보안 키
// with AES-256-GCM, and the answer comes back the same way, errors included.
// The protected header carries iat and a nonce besides alg and enc
// (https://docs.tosspayments.com/guides/v2/payouts#encryption-보안).

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// The security key is 64 hexadecimal characters: the 32 bytes of the
// AES-256 key.
export function securityKeyBytes(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("Toss security key must be 64 hexadecimal characters");
  }
  return Buffer.from(hex, "hex");
}

// yyyy-MM-dd'T'HH:mm:ss+09:00, the form Toss asks iat in.
export function kstTimestamp(now: Date): string {
  return `${new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}

const b64u = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

export function encryptJwe(
  plaintext: string,
  key: Buffer,
  opts: { now?: Date; nonce?: string; iv?: Buffer } = {},
): string {
  const header = b64u(
    JSON.stringify({
      alg: "dir",
      enc: "A256GCM",
      iat: kstTimestamp(opts.now ?? new Date()),
      nonce: opts.nonce ?? randomUUID(),
    }),
  );
  const iv = opts.iv ?? randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(header, "ascii"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  // Direct encryption sends no encrypted key: the second part is empty.
  return [
    header,
    "",
    b64u(iv),
    b64u(ciphertext),
    b64u(cipher.getAuthTag()),
  ].join(".");
}

export function isCompactJwe(text: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/.test(
    text.trim(),
  );
}

export function decryptJwe(token: string, key: Buffer): string {
  const parts = token.trim().split(".");
  if (parts.length !== 5) throw new Error("Not a compact JWE");
  const [header, encryptedKey, iv, ciphertext, tag] = parts;
  const parsed = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  if (parsed.alg !== "dir" || parsed.enc !== "A256GCM" || encryptedKey !== "") {
    throw new Error(`Unexpected JWE header ${parsed.alg}/${parsed.enc}`);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(header, "ascii"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
