import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Which shards accept a connection (the router's probe before a write).
const down = new Set<string>();
vi.mock("cloudflare:sockets", () => ({
  connect: ({ hostname, port }: { hostname: string; port: number }) => {
    const refused = down.has(`${hostname}:${port}`);
    const opened = refused
      ? Promise.reject(new Error("Network connection lost."))
      : Promise.resolve({});
    opened.catch(() => {});
    return { opened, close: async () => {} };
  },
}));
const { default: router } = await import("./router");

const origins = [
  "http://127.0.0.1:40101",
  "http://127.0.0.1:40102",
  "http://127.0.0.1:40103",
  "http://127.0.0.1:40104",
];
const env = (overrides = "{}") =>
  ({
    NARU_SDK_SHARD_ORIGINS: origins.join(","),
    NARU_SDK_SHARD_OVERRIDES: overrides,
    SDK_FILES: {
      fetch: async () => new Response("export const createNaru = 0;"),
    },
  }) as never;

type Answer = (request: Request) => Response | Promise<Response>;
let answer: Answer;
const sent: Request[] = [];
beforeEach(() => {
  sent.length = 0;
  down.clear();
  answer = () => Response.json({ value: null });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    // Node wants duplex for a streamed body; workerd does not.
    const request = new Request(input, { ...init, duplex: "half" } as never);
    sent.push(request);
    const { host } = new URL(request.url);
    if (down.has(host)) throw new Error("Network connection lost.");
    return answer(request);
  });
});
afterEach(() => vi.unstubAllGlobals());

const call = (path: string, init?: RequestInit, overrides?: string) =>
  router.fetch!(
    new Request(`http://127.0.0.1:40100${path}`, init) as never,
    env(overrides),
  );

describe("each site's requests", () => {
  test("go to the shard its name hashes to, as they came", async () => {
    // alpha hashes to 3 of 4, limeburst to 2 (shards.test.ts).
    for (const [path, shard] of [
      ["/api/data/v1/alpha/posts/one?fresh=1", 3],
      ["/api/data/v1/limeburst/posts", 2],
      ["/v1/sites/alpha/render", 3],
      ["/v1/sites/limeburst/dump", 2],
    ] as const) {
      sent.length = 0;
      const response = await call(path, {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "CF-Connecting-IP": "203.0.113.7",
          "X-Forwarded-For": "203.0.113.7",
        },
        body: '{"route":"x"}',
      });
      expect(response.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toBe(`${origins[shard]}${path}`);
      expect(sent[0].method).toBe("POST");
      expect(sent[0].headers.get("authorization")).toBe("Bearer secret");
      expect(sent[0].headers.get("cf-connecting-ip")).toBe("203.0.113.7");
      expect(sent[0].headers.get("x-forwarded-for")).toBe("203.0.113.7");
      expect(await sent[0].text()).toBe('{"route":"x"}');
    }
  });

  test("go where an override says", async () => {
    await call("/api/data/v1/alpha/posts", {}, '{"alpha": 0}');
    expect(sent[0].url).toBe(`${origins[0]}/api/data/v1/alpha/posts`);
  });

  test("come back as the shard answered", async () => {
    answer = () =>
      new Response("moved", { status: 302, headers: { Location: "/x" } });
    const response = await call("/api/data/v1/alpha/posts");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/x");
  });

  test("without a site go to shard 0", async () => {
    await call("/v1/breakers/other", { method: "POST", body: "{}" });
    expect(sent[0].url).toBe(`${origins[0]}/v1/breakers/other`);
  });
});

describe("a shard that is restarting", () => {
  test("is waited for", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      down.add("127.0.0.1:40104");
      const read = call("/api/data/v1/alpha/posts");
      const write = call("/v1/sites/alpha/execute", {
        method: "POST",
        body: "{}",
      });
      await vi.advanceTimersByTimeAsync(1000);
      down.clear();
      await vi.advanceTimersByTimeAsync(500);
      expect((await read).status).toBe(200);
      expect((await write).status).toBe(200);
      // The write was sent once, when the shard took connections again.
      expect(sent.filter((request) => request.method === "POST")).toHaveLength(
        1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("is given up on after 10 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      down.add("127.0.0.1:40104");
      const read = call("/api/data/v1/alpha/posts");
      await vi.advanceTimersByTimeAsync(10_500);
      const response = await read;
      expect(response.status).toBe(502);
      expect(await response.text()).toBe("Shard 3 did not answer.");
    } finally {
      vi.useRealTimers();
    }
  });

  test("never has a write sent twice", async () => {
    // Accepted, then dropped mid-request: it may have run.
    answer = () => {
      throw new Error("Network connection lost.");
    };
    const response = await call("/v1/sites/alpha/execute", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(502);
    expect(sent).toHaveLength(1);
  });
});

describe("what the router answers itself", () => {
  test("/healthz, the SDK and what is not served", async () => {
    expect(await (await call("/healthz")).text()).toBe("ok");
    expect(sent).toHaveLength(0);
    const sdk = await call("/sdk/1/naru.js");
    expect(sdk.status).toBe(200);
    expect(await sdk.text()).toBe("export const createNaru = 0;");
    expect((await call("/")).status).toBe(404);
    expect((await call("/v1/pageviews/drain", { method: "POST" })).status).toBe(
      404,
    );
    expect(sent).toHaveLength(0);
  });

  test("/healthz/deep, from every shard", async () => {
    answer = () => new Response("ok");
    expect(await (await call("/healthz/deep")).text()).toBe("ok");
    expect(sent.map((request) => request.url)).toEqual(
      origins.map((origin) => `${origin}/healthz/deep`),
    );
    answer = (request) =>
      request.url.startsWith(origins[2])
        ? new Response("unhealthy", { status: 503 })
        : new Response("ok");
    const unhealthy = await call("/healthz/deep");
    expect(unhealthy.status).toBe(503);
    expect(await unhealthy.text()).toBe("unhealthy\nshard 2: 503 unhealthy\n");
  });
});

describe("the breakers' unnotified sites", () => {
  const ask = () =>
    call("/v1/breakers/unnotified", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      body: "{}",
    });

  test("are every shard's", async () => {
    answer = (request) =>
      Response.json({
        value: {
          sites: request.url.startsWith(origins[1])
            ? ["beta", "gamma"]
            : request.url.startsWith(origins[3])
              ? ["alpha"]
              : [],
        },
      });
    const response = await ask();
    expect(await response.json()).toEqual({
      value: { sites: ["beta", "gamma", "alpha"] },
    });
    expect(sent).toHaveLength(4);
    for (const request of sent) {
      expect(request.headers.get("authorization")).toBe("Bearer secret");
      expect(await request.text()).toBe("{}");
    }
  });

  test("are a shard's refusal when it refuses", async () => {
    answer = () => Response.json({ error: { status: 401 } }, { status: 401 });
    expect((await ask()).status).toBe(401);
  });

  test("leave out a shard that does not answer", async () => {
    answer = (request) => {
      if (request.url.startsWith(origins[0]))
        throw new Error("Network connection lost.");
      return Response.json({ value: { sites: ["beta"] } });
    };
    expect(await (await ask()).json()).toEqual({ value: { sites: ["beta"] } });
  });
});
