import { timingSafeEqual } from "node:crypto";
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

const files: Record<string, string> = {};
for (const login of ["alice", "carol"]) {
  files[`${login}/sdk/1.0.0/naru.js`] = `${login}'s own naru.js`;
  files[`${login}/api/data/v1/${login}/posts.json`] = `${login}'s own posts`;
}
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
  PRIVATE_FILES: { get: async () => null },
  DOMAINS: {
    async get() {
      return {
        confirmedUntil: Date.now() + 60_000,
        domains: {
          "alice.example": { login: "alice", entitledUntil: null },
          "lapsed.example": { login: "lapsed", entitledUntil: 1 },
        },
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
      // carol has no custom domain, so carol.naru.pub serves the site.
      for (const [host, login] of [
        ["carol.naru.pub", "carol"],
        ["alice.example", "alice"],
      ]) {
        const sdk = await get(handler, `https://${host}/sdk/1.0.0/naru.js`);
        expect(sdk.status).toBe(200);
        expect(await sdk.text()).toBe(`${login}'s own naru.js`);
        const data = await get(
          handler,
          `https://${host}/api/data/v1/${login}/posts.json`,
        );
        expect(data.status).toBe(200);
        expect(await data.text()).toBe(`${login}'s own posts`);
        const missing = await get(handler, `https://${host}/sdk/1/naru.js`);
        expect(missing.status).toBe(404);
      }
    });
});

describe("a site served on a custom domain", () => {
  const request = (url: string, init?: RequestInit) =>
    worker.fetch!(new Request(url, init) as never, env, ctx);

  test("moves its subdomain's pages there, keeping path and query", async () => {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(
        "https://alice.naru.pub/sdk/1.0.0/naru.js?v=2",
        { method },
      );
      expect(response.status).toBe(301);
      expect(response.headers.get("Location")).toBe(
        "https://alice.example/sdk/1.0.0/naru.js?v=2",
      );
      expect(response.headers.get("Cache-Control")).toBe("max-age=86400");
    }
  });

  test("answers a post where it was sent", async () => {
    const response = await request("https://alice.naru.pub/form", {
      method: "POST",
    });
    expect(response.status).not.toBe(301);
  });

  test("leaves the subdomain alone once the domain is not served", async () => {
    const response = await request("https://lapsed.naru.pub/");
    expect(response.status).not.toBe(301);
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

/** A bucket holding just `objects`. */
const holding = (objects: Record<string, string>) => ({
  async get(key: string) {
    if (!(key in objects)) return null;
    const body = objects[key];
    return {
      size: body.length,
      httpEtag: '"1"',
      httpMetadata: { contentType: "text/html" },
      body: new Response(body).body,
      json: async () => JSON.parse(body),
    };
  },
});

describe("a route's page rendered on the mini, through the Standby object", () => {
  const routed = (forward: (request: Request) => Promise<Response>) => ({
    ...(env as object),
    SDK_ORIGIN_SECRET: "secret",
    SITE_FILES: holding({ "bob/index.html": "<p>bob's app</p>" }),
    PRIVATE_FILES: holding({
      "_naru-runtime/bob/routes.json": JSON.stringify({
        include: ["/posts/*"],
      }),
    }),
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

describe("a write the runtime stopped at its step budget", () => {
  // Naru's workerd on the mini (seoul/workerd/) resets the object, and its
  // caller's stub throws SQLite's interrupt instead of the object's answer.
  const stopped = () => {
    throw new Error("interrupted: SQLITE_INTERRUPT");
  };
  // workerd's, which Node's Web Crypto lacks.
  Object.assign(crypto.subtle, {
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b),
  });
  const sites = (method: () => unknown) => ({
    ...(env as object),
    EDGE_WORKER_SECRET: "secret",
    SQLITE_STATEMENT_TIMEOUT_MS: "3000",
    SITES: {
      idFromName: () => ({}),
      get: () => new Proxy({}, { get: () => method }),
    },
  });
  const operate = (operation: string, method: () => unknown = stopped) =>
    worker.fetch!(
      new Request(`http://localhost/v1/sites/alice/${operation}`, {
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        body: "{}",
      }) as never,
      sites(method) as never,
      ctx,
    );

  test("is the site's statement in a call, and its release's in an activation", async () => {
    const call = await operate("call");
    expect(call.status).toBe(400);
    expect(await call.json()).toEqual({
      error: {
        status: 400,
        code: "INVALID_REQUEST",
        message:
          "This statement ran longer than 3 seconds and was stopped; give it an index or read less.",
      },
    });
    // Refused for good: the control plane's release task stops retrying it.
    const activation = await operate("activateFunctions");
    expect(activation.status).toBe(422);
    expect(await activation.json()).toMatchObject({
      error: {
        status: 422,
        code: "INVALID_REQUEST",
        message: expect.stringMatching(
          /^A migration ran longer than 3 seconds/,
        ),
        details: { reason: "migration_failed" },
      },
    });
    // One of Naru's own: the database is unavailable for now.
    const restore = await operate("restoreFrom");
    expect(restore.status).toBe(503);
    expect(await restore.json()).toMatchObject({
      error: { code: "UNAVAILABLE" },
    });
  });

  test("leaves any other failure of the object as it was", async () => {
    await expect(
      operate("call", () => {
        throw new Error("Network connection lost.");
      }),
    ).rejects.toThrow("Network connection lost.");
  });

  test("is a visitor's call's own statement at the data API", async () => {
    const response = await local.fetch!(
      new Request("https://sdk.naru.pub/api/data/v1/alice/_mutate/posts:add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: null }),
      }) as never,
      sites(stopped) as never,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringMatching(
          /^This statement ran longer than 3 seconds/,
        ),
      },
    });
  });
});
