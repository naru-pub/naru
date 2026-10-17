import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
// Site objects, and the QuickJS module they load, are not needed here.
vi.mock("./site", () => ({ SiteData: class {} }));
const { default: worker } = await import("./index");
const { default: local } = await import("./local");
const { notFound } = await import("./pages");

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

describe("a route's page rendered on the mini, through the Standby object", () => {
  const routed = (forward: (request: Request) => Promise<Response>) => ({
    ...(env as object),
    SDK_ORIGIN_SECRET: "secret",
    SITE_FILES: {
      async get(key: string) {
        const body =
          key === "_naru-runtime/bob/routes.json"
            ? JSON.stringify({ routes: ["posts/_id"] })
            : key === "bob/index.html"
              ? "<p>bob's app</p>"
              : null;
        if (body === null) return null;
        return {
          size: body.length,
          httpEtag: '"1"',
          httpMetadata: { contentType: "text/html" },
          body: new Response(body).body,
          json: async () => JSON.parse(body),
        };
      },
    },
    STANDBY: {
      idFromName: () => ({}),
      get: () => ({ forward }),
    },
  });
  const navigate = (forward: (request: Request) => Promise<Response>) =>
    worker.fetch!(
      new Request("https://bob.naru.pub/posts/1", {
        headers: { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
      }) as never,
      routed(forward) as never,
      ctx,
    );
  const refusal = (status: number, error: object) =>
    Response.json({ error: { status, ...error } }, { status });

  test("a lapsed site's refusal is a plain 404", async () => {
    const page = await navigate(async () =>
      refusal(404, {
        message: "Not Found",
        code: "NOT_FOUND",
        details: { reason: "routes_off" },
      }),
    );
    expect(page.status).toBe(404);
    expect(await page.text()).toBe(await notFound().text());
  });

  test("the mini away is the site's index.html at 503", async () => {
    for (const forward of [
      // Caddy with workerd down, or the line timing out.
      async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      async () => new Response("", { status: 504 }),
      // The object itself unavailable.
      async () =>
        refusal(503, { message: "Function failed.", code: "UNAVAILABLE" }),
      // A JSON body whose status is not the response's is not the object's.
      async () =>
        refusal(404, { details: { reason: "routes_off" } })
          .json()
          .then((body) => Response.json(body, { status: 502 })),
      async () => {
        throw new Error("connection refused");
      },
    ]) {
      const page = await navigate(forward);
      expect(page.status).toBe(503);
      expect(await page.text()).toBe("<p>bob's app</p>");
      expect(page.headers.get("Retry-After")).toBe("60");
    }
  });
});
