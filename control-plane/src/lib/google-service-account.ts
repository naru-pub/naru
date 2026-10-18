import { createPrivateKey, sign, type KeyObject } from "node:crypto";

// A Google service account's OAuth access tokens, from its JSON key as Google
// issued it: a signed assertion traded at its token endpoint, kept until a
// minute before it expires. FCM pushes (lib/app-api/push) and the Play
// Developer API (lib/payments/store/google) each use their own account.
export class GoogleServiceAccount {
  readonly projectId: string;
  private key: KeyObject;
  private clientEmail: string;
  private tokenUri: string;
  private access: { value: string; until: number } | null = null;

  constructor(
    json: string,
    private scope: string,
  ) {
    const parsed = JSON.parse(json);
    this.projectId = parsed.project_id;
    this.clientEmail = parsed.client_email;
    this.tokenUri = parsed.token_uri ?? "https://oauth2.googleapis.com/token";
    this.key = createPrivateKey(parsed.private_key.replace(/\\n/g, "\n"));
  }

  async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.access && this.access.until > now + 60) return this.access.value;
    const assertion = signedJwt(
      { alg: "RS256", typ: "JWT" },
      {
        iss: this.clientEmail,
        scope: this.scope,
        aud: this.tokenUri,
        iat: now,
        exp: now + 3600,
      },
      this.key,
      "RS256",
    );
    const response = await fetch(this.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`Google sign-in failed: ${response.status}`);
    const { access_token, expires_in } = await response.json();
    this.access = { value: access_token, until: now + Number(expires_in) };
    return this.access.value;
  }
}

const base64url = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

export function signedJwt(
  header: Record<string, string>,
  claims: Record<string, unknown>,
  key: KeyObject,
  algorithm: "ES256" | "RS256",
) {
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign(
    "sha256",
    Buffer.from(input),
    algorithm === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key,
  );
  return `${input}.${base64url(signature)}`;
}
