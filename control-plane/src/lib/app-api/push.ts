import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import {
  GoogleServiceAccount,
  signedJwt as jwt,
} from "@/lib/google-service-account";

// Pushes to the Naru app's devices: APNs for iOS and macOS, FCM for Android.
// Naru's own credentials, from the environment; without them that platform's
// pushes are skipped and notifications wait in the app's inbox.
//
// - APNS_KEY_ID, APNS_TEAM_ID, and the token-based key: APNS_PRIVATE_KEY_FILE,
//   the path of the .p8 as Apple issued it, or APNS_PRIVATE_KEY, its PEM
//   with newlines as \n.
// - FCM_SERVICE_ACCOUNT_FILE, the path of the Firebase project's
//   service-account JSON as Google issued it, or FCM_SERVICE_ACCOUNT, the
//   JSON itself.

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
      request.setTimeout(10_000, () =>
        request.close(http2.constants.NGHTTP2_CANCEL),
      );
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
  private account: GoogleServiceAccount;

  constructor(serviceAccount: string) {
    this.account = new GoogleServiceAccount(
      serviceAccount,
      "https://www.googleapis.com/auth/firebase.messaging",
    );
  }

  private bearer() {
    return this.account.accessToken();
  }

  async send(device: Device, message: PushMessage): Promise<PushResult> {
    try {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${this.account.projectId}/messages:send`,
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
      if (response.status === 404 || text.includes("UNREGISTERED"))
        return "gone";
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
export function pushSender(
  env: Record<string, string | undefined> = process.env,
): PushSender {
  const apnsKey = env.APNS_PRIVATE_KEY_FILE
    ? readFileSync(env.APNS_PRIVATE_KEY_FILE, "utf8")
    : env.APNS_PRIVATE_KEY;
  const apns =
    env.APNS_KEY_ID && env.APNS_TEAM_ID && apnsKey
      ? new Apns(env.APNS_KEY_ID, env.APNS_TEAM_ID, apnsKey)
      : null;
  const fcmAccount = env.FCM_SERVICE_ACCOUNT_FILE
    ? readFileSync(env.FCM_SERVICE_ACCOUNT_FILE, "utf8")
    : env.FCM_SERVICE_ACCOUNT;
  const fcm = fcmAccount ? new Fcm(fcmAccount) : null;
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
