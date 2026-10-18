import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import http2 from "node:http2";

// Pushes to the Naru app's devices: APNs for iOS and macOS, FCM for Android.
// Naru's own credentials, from the environment; without them that platform's
// pushes are skipped and notifications wait in the app's inbox.
//
// - APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY: a token-based (.p8) key; the
//   PEM may have its newlines as \n.
// - FCM_SERVICE_ACCOUNT: the Firebase project's service-account JSON.

export interface PushMessage {
  /** app_notifications.id */
  id: string;
  site: string;
  siteTitle: string;
  title: string;
  body: string;
  url: string;
  badge: number;
}

export interface Device {
  platform: "apns" | "fcm";
  token: string;
  environment: "sandbox" | "production";
  bundle_id: string;
}

/** delivered; gone (the token is dead, forget it); failed (try another time). */
export type PushResult = "delivered" | "gone" | "failed" | "unconfigured";

export interface PushSender {
  send(device: Device, message: PushMessage): Promise<PushResult>;
  close(): void;
}

const base64url = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

function jwt(
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

const pem = (value: string) => value.replace(/\\n/g, "\n");

class Apns {
  private sessions = new Map<string, http2.ClientHttp2Session>();
  private token: { value: string; at: number } | null = null;
  private key: KeyObject;

  constructor(
    private keyId: string,
    private teamId: string,
    privateKey: string,
  ) {
    this.key = createPrivateKey(pem(privateKey));
  }

  /** Apple takes a provider token for up to an hour; renewed after 50 minutes. */
  private bearer() {
    const now = Math.floor(Date.now() / 1000);
    if (!this.token || now - this.token.at > 50 * 60)
      this.token = {
        at: now,
        value: jwt(
          { alg: "ES256", kid: this.keyId },
          { iss: this.teamId, iat: now },
          this.key,
          "ES256",
        ),
      };
    return this.token.value;
  }

  private session(environment: Device["environment"]) {
    const origin =
      environment === "sandbox"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";
    let session = this.sessions.get(origin);
    if (!session || session.closed || session.destroyed) {
      session = http2.connect(origin);
      session.on("error", () => this.sessions.delete(origin));
      this.sessions.set(origin, session);
    }
    return session;
  }

  send(device: Device, message: PushMessage): Promise<PushResult> {
    const payload = JSON.stringify({
      aps: {
        alert: {
          title: message.title,
          subtitle: message.siteTitle,
          body: message.body,
        },
        sound: "default",
        badge: message.badge,
        "thread-id": message.site,
      },
      naru: { id: message.id, url: message.url },
    });
    return new Promise((resolve) => {
      let request: http2.ClientHttp2Stream;
      try {
        request = this.session(device.environment).request({
          ":method": "POST",
          ":path": `/3/device/${device.token}`,
          authorization: `bearer ${this.bearer()}`,
          "apns-topic": device.bundle_id,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-collapse-id": message.id.slice(0, 64),
          "content-type": "application/json",
        });
      } catch {
        resolve("failed");
        return;
      }
      let status = 0;
      let body = "";
      request.setTimeout(10_000, () => request.close(http2.constants.NGHTTP2_CANCEL));
      request.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      request.on("data", (chunk) => (body += chunk));
      request.on("error", () => resolve("failed"));
      request.on("close", () => {
        if (status === 200) return resolve("delivered");
        const reason = (() => {
          try {
            return JSON.parse(body).reason as string;
          } catch {
            return "";
          }
        })();
        // Uninstalled, or a token for another app or environment.
        if (
          status === 410 ||
          ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(
            reason,
          )
        )
          return resolve("gone");
        if (status) console.warn(`[app-push] APNs ${status} ${reason}`);
        resolve("failed");
      });
      request.end(payload);
    });
  }

  close() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

class Fcm {
  private access: { value: string; until: number } | null = null;
  private key: KeyObject;
  private account: { client_email: string; project_id: string; token_uri: string };

  constructor(serviceAccount: string) {
    const parsed = JSON.parse(serviceAccount);
    this.account = {
      client_email: parsed.client_email,
      project_id: parsed.project_id,
      token_uri: parsed.token_uri ?? "https://oauth2.googleapis.com/token",
    };
    this.key = createPrivateKey(pem(parsed.private_key));
  }

  private async bearer() {
    const now = Math.floor(Date.now() / 1000);
    if (this.access && this.access.until > now + 60) return this.access.value;
    const assertion = jwt(
      { alg: "RS256", typ: "JWT" },
      {
        iss: this.account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: this.account.token_uri,
        iat: now,
        exp: now + 3600,
      },
      this.key,
      "RS256",
    );
    const response = await fetch(this.account.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`FCM sign-in failed: ${response.status}`);
    const { access_token, expires_in } = await response.json();
    this.access = { value: access_token, until: now + Number(expires_in) };
    return this.access.value;
  }

  async send(device: Device, message: PushMessage): Promise<PushResult> {
    try {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await this.bearer()}`,
            "Content-Type": "application/json",
          },
          // A data message: the app builds the notification and its channel.
          body: JSON.stringify({
            message: {
              token: device.token,
              data: {
                id: message.id,
                site: message.site,
                siteTitle: message.siteTitle,
                title: message.title,
                body: message.body,
                url: message.url,
              },
              android: { priority: "high" },
            },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.ok) return "delivered";
      const text = await response.text();
      if (response.status === 404 || text.includes("UNREGISTERED")) return "gone";
      console.warn(`[app-push] FCM ${response.status} ${text.slice(0, 200)}`);
      return "failed";
    } catch (error) {
      console.warn("[app-push] FCM request failed:", error);
      return "failed";
    }
  }

  close() {}
}

/** The senders the environment configures. */
export function pushSender(env = process.env): PushSender {
  const apns =
    env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY
      ? new Apns(env.APNS_KEY_ID, env.APNS_TEAM_ID, env.APNS_PRIVATE_KEY)
      : null;
  const fcm = env.FCM_SERVICE_ACCOUNT ? new Fcm(env.FCM_SERVICE_ACCOUNT) : null;
  return {
    async send(device, message) {
      const sender = device.platform === "apns" ? apns : fcm;
      return sender ? sender.send(device, message) : "unconfigured";
    },
    close() {
      apns?.close();
      fcm?.close();
    },
  };
}
