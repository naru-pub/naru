/** @jest-environment node */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import {
  appJwt,
  downloadArchive,
  github,
  installationToken,
  userInstallations,
  verifyWebhookSignature,
} from "../githubApp";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const realFetch = github.fetch;
let requests: { url: string; init: RequestInit }[];

beforeEach(() => {
  Object.assign(process.env, {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "naru",
    GITHUB_APP_CLIENT_ID: "Iv1.client",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: Buffer.from(
      privateKey.export({ type: "pkcs1", format: "pem" }),
    ).toString("base64"),
    GITHUB_APP_WEBHOOK_SECRET: "hook-secret",
  });
  requests = [];
});
afterEach(() => {
  github.fetch = realFetch;
});
const answer = (respond: (url: string) => Response) => {
  github.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return respond(String(input));
  };
};

describe("GitHub App", () => {
  it("signs its JWT with the App's key, for the App, briefly", () => {
    const now = Date.parse("2030-01-01T00:00:00Z");
    const [header, payload, signature] = appJwt(now).split(".");
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
      iss: "12345",
    });
  });

  it("accepts only deliveries signed with the webhook secret", () => {
    const body = '{"zen":"hi"}';
    const signed = `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
    expect(verifyWebhookSignature(body, signed)).toBe(true);
    expect(verifyWebhookSignature(`${body} `, signed)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=00")).toBe(false);
    expect(verifyWebhookSignature(body, null)).toBe(false);
  });

  it("asks for a token that can only read the one repository", async () => {
    answer(() => Response.json({ token: "ghs_x" }));
    expect(await installationToken("77", "1001")).toBe("ghs_x");
    expect(requests[0].url).toBe(
      "https://api.github.com/app/installations/77/access_tokens",
    );
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      permissions: { contents: "read", metadata: "read" },
      repository_ids: [1001],
    });
  });

  it("finds the installations a user reaches, with only the repositories they can read", async () => {
    answer((url) =>
      url.includes("/user/installations?")
        ? Response.json({
            installations: [{ id: 77, account: { login: "naru-pub" } }],
          })
        : Response.json({ repositories: [{ id: 1001 }, { id: 1002 }] }),
    );
    expect(await userInstallations("ghu_user")).toEqual([
      {
        installationId: "77",
        accountLogin: "naru-pub",
        repositoryIds: ["1001", "1002"],
      },
    ]);
    expect(requests[1].url).toContain("/user/installations/77/repositories");
    expect(
      (requests[1].init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer ghu_user");
  });

  it("refuses an archive larger than the limit while it downloads", async () => {
    answer(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(32 * 1024 * 1024));
            },
          }),
        ),
    );
    await expect(downloadArchive("ghs_x", "1001", "abc")).rejects.toThrow(
      "larger than 100 MB",
    );
  });
});
