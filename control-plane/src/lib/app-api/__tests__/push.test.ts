/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushSender } from "../push";

const device = {
  platform: "apns" as const,
  token: "ab".repeat(32),
  environment: "sandbox" as const,
  bundle_id: "pub.naru",
};
const message = {
  id: "1",
  site: "s",
  siteTitle: "s",
  title: "t",
  body: "",
  url: "https://s.naru.pub/",
  badge: 0,
};

describe("the push sender", () => {
  test("skips a platform without credentials", async () => {
    const sender = pushSender({});
    expect(await sender.send(device, message)).toBe("unconfigured");
    sender.close();
  });

  test("takes the APNs key as a .p8 file", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const file = join(mkdtempSync(join(tmpdir(), "apns-")), "AuthKey_TEST.p8");
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }));
    // A key that does not parse throws here, before any push.
    const sender = pushSender({
      APNS_KEY_ID: "TESTKEY123",
      APNS_TEAM_ID: "K4CQ85R27U",
      APNS_PRIVATE_KEY_FILE: file,
    });
    sender.close();
    expect(() =>
      pushSender({
        APNS_KEY_ID: "TESTKEY123",
        APNS_TEAM_ID: "K4CQ85R27U",
        APNS_PRIVATE_KEY_FILE: join(tmpdir(), "missing.p8"),
      }),
    ).toThrow();
  });

  test("takes the FCM service account as a JSON file", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const file = join(mkdtempSync(join(tmpdir(), "fcm-")), "service-account.json");
    writeFileSync(
      file,
      JSON.stringify({
        type: "service_account",
        project_id: "naru-test",
        client_email: "push@naru-test.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    );
    pushSender({ FCM_SERVICE_ACCOUNT_FILE: file }).close();
    expect(() =>
      pushSender({ FCM_SERVICE_ACCOUNT_FILE: join(tmpdir(), "missing.json") }),
    ).toThrow();
  });
});
