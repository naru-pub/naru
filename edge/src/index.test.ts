import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
// Site objects, and the QuickJS module they load, are not needed here.
vi.mock("./site", () => ({ SiteData: class {} }));
const { default: worker } = await import("./index");
const { default: local } = await import("./local");

// The Worker on Cloudflare serves no Data SDK and no data API: a hosted
// site's own /sdk/ and /api/data/v1/ paths, on its subdomain or a custom
// domain, are its files like any other path.

const files: Record<string, string> = {
  "alice/sdk/1.0.0/naru.js": "alice's own naru.js",
  "alice/api/data/v1/alice/posts.json": "alice's own posts",
};
const env = {
  PLATFORM_DOMAIN: "naru.pub",
  R2_PUBLIC_DOMAIN: "r2.naru.pub",
  SITE_FILES: {
    async get(key: string) {
      if (!(key in files)) return null;
      return {
        size: files[key].length,
        httpEtag: `"${key.length}"`,
        httpMetadata: { contentType: "text/plain" },
        body: new Response(files[key]).body,
      };
    },
  },
  DOMAINS: {
    async get() {
      return {
        confirmedUntil: Date.now() + 60_000,
        domains: { "alice.example": { login: "alice", entitledUntil: null } },
      };
    },
  },
  PAGEVIEWS: {
    idFromName: () => ({}),
    get: () => ({ record: async () => {} }),
  },
} as never;
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

type Fetch = (request: never, env: never, ctx: never) => Promise<Response>;
const get = (handler: { fetch?: Fetch }, url: string) =>
  handler.fetch!(new Request(url) as never, env, ctx);

describe("a hosted site's /sdk/ and /api/data/v1/ paths", () => {
  for (const [name, handler] of [
    ["on Cloudflare", worker],
    ["in local runs", local],
  ] as const)
    test(`are its own files ${name}`, async () => {
      for (const host of ["alice.naru.pub", "alice.example"]) {
        const sdk = await get(handler, `https://${host}/sdk/1.0.0/naru.js`);
        expect(sdk.status).toBe(200);
        expect(await sdk.text()).toBe("alice's own naru.js");
        const data = await get(
          handler,
          `https://${host}/api/data/v1/alice/posts.json`,
        );
        expect(data.status).toBe(200);
        expect(await data.text()).toBe("alice's own posts");
        const missing = await get(handler, `https://${host}/sdk/1/naru.js`);
        expect(missing.status).toBe(404);
      }
    });
});

describe("the platform's hosts on Cloudflare", () => {
  test("serve no Data SDK and no data API", async () => {
    for (const path of ["/sdk/1.0.0/naru.js", "/api/data/v1/alice/posts"]) {
      const response = await get(worker, `https://edge.naru.pub${path}`);
      expect(response.status).toBe(401);
    }
  });
});
