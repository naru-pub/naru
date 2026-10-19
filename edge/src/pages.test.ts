import { afterEach, describe, expect, test } from "vitest";
import {
  classify,
  decodePath,
  directoryRedirect,
  pageviewPath,
  resolvePath,
  servePage,
  siteOf,
  truncate,
  type PagesEnv,
} from "./pages";
import type { PageviewEvent } from "./pageview-log";

// The retired proxy's own cases, ported from its Rust tests, so sites keep
// answering as they did, and the handler against a bucket held in memory.

const env = (
  files: Record<string, string> = {},
  reads: string[] = [],
): PagesEnv => ({
  PLATFORM_DOMAIN: "naru.pub",
  R2_PUBLIC_DOMAIN: "r2.naru.pub",
  SITE_FILES: {
    async get(key: string) {
      reads.push(key);
      if (!(key in files)) return null;
      return {
        ...metadata(key, files[key]),
        body: new Response(files[key]).body,
      };
    },
  } as unknown as R2Bucket,
  PRIVATE_FILES: { get: async () => null } as unknown as R2Bucket,
});

/** An object's metadata, its ETag made from its contents. */
function metadata(key: string, body: string) {
  let hash = 0;
  for (const char of body) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return {
    size: new TextEncoder().encode(body).byteLength,
    httpEtag: `"${hash.toString(16).padStart(8, "0")}0000aaaa"`,
    httpMetadata: {
      contentType: key.endsWith(".json")
        ? "application/json"
        : /\.m?js$/.test(key)
          ? "application/javascript"
          : "text/html",
    },
  };
}

/** An ExecutionContext whose deferred work a test can wait for. */
const context = () => {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    settled: () => Promise.all(pending),
  };
};

describe("hosts", () => {
  test("names a site by its login, reserved logins too", () => {
    expect(siteOf("alice.naru.pub", env())).toBe("alice");
    expect(siteOf("Alice.Naru.Pub.", env())).toBe("alice");
    // Reserved for the payment operator, whose own site it is.
    expect(siteOf("yang.naru.pub", env())).toBe("yang");
  });

  test("names no site for the platform's own hosts and other names", () => {
    for (const host of [
      "naru.pub",
      "r2.naru.pub",
      "a.b.naru.pub",
      "_mta-sts.naru.pub",
      "bad--name.naru.pub",
      "limeburst.net",
      "alice.naru.pub.evil.example",
    ])
      expect(siteOf(host, env())).toBeNull();
  });
});

describe("paths", () => {
  test("resolves directories to their index", () => {
    for (const [path, file] of [
      ["", "index.html"],
      ["index.html", "index.html"],
      ["about/", "about/index.html"],
      ["foo/bar/", "foo/bar/index.html"],
      ["about", "about/index.html"],
      ["foo/bar", "foo/bar/index.html"],
      ["file.html", "file.html"],
      ["script.js", "script.js"],
      ["data.json", "data.json"],
      ["path/to/file.html", "path/to/file.html"],
      ["my.site/about", "my.site/about/index.html"],
      ["v1.0/docs", "v1.0/docs/index.html"],
      [".hidden", ".hidden/index.html"],
      ["path/.env", "path/.env/index.html"],
      ["file.", "file./index.html"],
    ])
      expect(resolvePath(path)).toBe(file);
  });

  test("decodes percent escapes as bytes, and invalid UTF-8 as the root", () => {
    expect(decodePath("%EB%B8%94%EB%A1%9C%EA%B7%B8")).toBe("블로그");
    expect(decodePath("a%3Fb%23c")).toBe("a?b#c");
    expect(decodePath("100%")).toBe("100%");
    expect(decodePath("%zz/a+b")).toBe("%zz/a+b");
    expect(decodePath("%FF")).toBe("");
  });

  test("redirects a directory to its slash, keeping the URL and query", () => {
    for (const [url, decoded, expected] of [
      ["/blog", "blog", "/blog/"],
      [
        "/nested/blog?page=2&tag=a%2Fb",
        "nested/blog",
        "/nested/blog/?page=2&tag=a%2Fb",
      ],
      [
        "/%EB%B8%94%EB%A1%9C%EA%B7%B8",
        "블로그",
        "/%EB%B8%94%EB%A1%9C%EA%B7%B8/",
      ],
      ["/a%3Fb%23c", "a?b#c", "/a%3Fb%23c/"],
      ["/blog%2F", "blog/", "/blog%2F/"],
      ["/blog?", "blog", "/blog/?"],
    ])
      expect(
        directoryRedirect(new URL(url, "https://alice.naru.pub"), decoded),
      ).toBe(expected);
  });

  test("leaves files and canonical URLs alone", () => {
    for (const [url, decoded] of [
      ["/", ""],
      ["/blog/", "blog/"],
      ["/blog/?page=2", "blog/"],
      ["/index.html", "index.html"],
      ["/blog/index.html", "blog/index.html"],
      ["/blog/app.js", "blog/app.js"],
    ])
      expect(
        directoryRedirect(new URL(url, "https://alice.naru.pub"), decoded),
      ).toBeNull();
  });

  test("counts a page under its directory", () => {
    expect(pageviewPath("")).toBe("/");
    expect(pageviewPath("index.html")).toBe("/");
    expect(pageviewPath("blog/")).toBe("/blog");
    expect(pageviewPath("blog/index.html")).toBe("/blog");
    expect(pageviewPath("blog/post.html")).toBe("/blog/post.html");
  });
});

describe("pageviews", () => {
  const request = (headers: Record<string, string>, method = "GET") =>
    new Request("https://alice.naru.pub/", { method, headers });

  test("classifies navigation intent from Fetch Metadata alone", () => {
    const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    expect(classify(request(nav))).toBe("navigation");
    expect(classify(request(nav, "POST"))).toBe("background");
    expect(
      classify(
        request({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }),
      ),
    ).toBe("frame");
    expect(classify(request({ "sec-fetch-mode": "navigate" }))).toBe("unknown");
    expect(classify(request({}))).toBe("unknown");
    expect(
      classify(
        request({ "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }),
      ),
    ).toBe("background");
  });

  test("truncates metadata to 2048 bytes on a character boundary", () => {
    expect(truncate(null)).toBeNull();
    expect(truncate("short")).toBe("short");
    expect(new TextEncoder().encode(truncate("a".repeat(3000))!)).toHaveLength(
      2048,
    );
    // "가" is three bytes: 682 of them fill 2046 of 2048.
    expect(truncate("가".repeat(1000))).toBe("가".repeat(682));
  });
});

describe("serving", () => {
  const files = {
    "alice/index.html": "<h1>home</h1>",
    "alice/blog/index.html": "<h1>blog</h1>",
    "alice/data.json": "{}",
  };
  const visit = async (path: string, headers: Record<string, string> = {}) => {
    const events: PageviewEvent[] = [];
    const response = await servePage(
      new Request(`https://alice.naru.pub${path}`, { headers }),
      env(files),
      "alice",
      context(),
      (event) => events.push(event),
    );
    return { response, events };
  };
  const navigation = {
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "cf-connecting-ip": "203.0.113.7",
    referer: "https://example.com/",
    "user-agent": "test",
  };

  test("serves a page from the site's prefix and counts a navigation", async () => {
    const { response, events } = await visit("/", navigation);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>home</h1>");
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, stale-if-error=86400",
    );
    expect(events).toEqual([
      {
        login: "alice",
        timestamp: expect.any(Number),
        path: "/",
        ip: "203.0.113.7",
        referrer: "https://example.com/",
        userAgent: "test",
      },
    ]);
  });

  test("counts no request that is not a navigation to a page", async () => {
    expect((await visit("/")).events).toEqual([]);
    expect((await visit("/data.json", navigation)).events).toEqual([]);
    const { response, events } = await visit("/blog", navigation);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/blog/");
    expect(events).toEqual([]);
  });

  test("redirects other files to the bucket's public domain", async () => {
    const { response } = await visit("/images/cat.png");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://r2.naru.pub/alice/images/cat.png",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=604800, stale-if-error=86400",
    );
  });

  test("encodes a redirect as the control plane purges it", async () => {
    for (const [path, location] of [
      // A name's ? and # stay in the path, not a query or fragment.
      ["/a%3Fb%23c.png", "https://r2.naru.pub/alice/a%3Fb%23c.png"],
      ["/a%20b%20(1)!.png", "https://r2.naru.pub/alice/a%20b%20(1)!.png"],
      [
        "/%EC%82%AC%EC%A7%84/%EA%B3%A0%EC%96%91%EC%9D%B4.png",
        "https://r2.naru.pub/alice/%EC%82%AC%EC%A7%84/%EA%B3%A0%EC%96%91%EC%9D%B4.png",
      ],
      [
        "/img/a+b,c;d=e.png",
        "https://r2.naru.pub/alice/img/a%2Bb%2Cc%3Bd%3De.png",
      ],
    ]) {
      const { response } = await visit(path);
      expect(response.headers.get("location")).toBe(location);
    }
  });

  test("answers a missing page 404, uncached", async () => {
    const { response } = await visit("/nowhere/", navigation);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // As the proxy: no type on its plain answers.
    expect(response.headers.get("content-type")).toBeNull();
  });

  test("answers a bucket failure 502, never 404", async () => {
    const failing = env();
    failing.SITE_FILES = {
      get: () => Promise.reject(new Error("down")),
    } as unknown as R2Bucket;
    const response = await servePage(
      new Request("https://alice.naru.pub/"),
      failing,
      "alice",
      context(),
      () => {},
    );
    expect(response.status).toBe(502);
  });
});

describe("caching", () => {
  // Cloudflare's cache, as the Worker sees it in one data center.
  const entries = new Map<
    string,
    { status: number; headers: Headers; body: string }
  >();
  const cache = {
    async match(url: string) {
      const entry = entries.get(url);
      return entry && new Response(entry.body || null, entry);
    },
    async put(url: string, response: Response) {
      entries.set(url, {
        status: response.status,
        headers: response.headers,
        body: await response.text(),
      });
    },
  };
  afterEach(() => {
    entries.clear();
    delete (globalThis as { caches?: unknown }).caches;
  });

  const files: Record<string, string> = {
    "alice/index.html": "<h1>home</h1>",
    "alice/blog/index.html": "<h1>blog</h1>",
  };
  const reads: string[] = [];
  const cached = { ...env(files, reads), SITE_FILE_CACHE_SECONDS: "60" };
  const visit = async (path: string, siteEnv: PagesEnv = cached) => {
    (globalThis as { caches?: unknown }).caches = { default: cache };
    const ctx = context();
    const response = await servePage(
      new Request(`https://alice.naru.pub${path}`),
      siteEnv,
      "alice",
      ctx,
      () => {},
    );
    const body = await response.text();
    await ctx.settled();
    return { response, body };
  };

  test("reads a file from the bucket once, then from the cache", async () => {
    reads.length = 0;
    for (const path of ["/", "/index.html", "/"]) {
      const { response, body } = await visit(path);
      expect(response.status).toBe(200);
      expect(body).toBe("<h1>home</h1>");
      expect(response.headers.get("content-type")).toBe("text/html");
      // Browsers still revalidate: only the edge keeps it.
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=0, stale-if-error=86400",
      );
    }
    expect(reads).toEqual(["alice/index.html"]);
    const entry = entries.get("https://alice.naru.pub/index.html")!;
    expect(entry.headers.get("cache-control")).toBe("public, max-age=60");
    expect(entry.headers.get("cache-tag")).toBe("naru-site-alice");
  });

  test("keeps a file's absence too", async () => {
    reads.length = 0;
    expect((await visit("/nowhere.html")).response.status).toBe(404);
    expect((await visit("/nowhere.html")).response.status).toBe(404);
    expect(reads).toEqual(["alice/nowhere.html"]);
  });

  test("redirects a cached directory to its trailing slash", async () => {
    await visit("/blog/");
    // Named by the bucket key, its path encoded whole.
    expect([...entries.keys()]).toEqual([
      "https://alice.naru.pub/blog%2Findex.html",
    ]);
    const { response } = await visit("/blog");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/blog/");
  });

  test("reads the bucket every time when no lifetime is set", async () => {
    reads.length = 0;
    const uncached = env(files, reads);
    await visit("/", uncached);
    await visit("/", uncached);
    expect(reads).toEqual(["alice/index.html", "alice/index.html"]);
    expect(entries.size).toBe(0);
  });
});

test("serves a deployed .mjs module directly with a JavaScript MIME type", async () => {
  const ctx = context();
  const response = await servePage(
    new Request("https://alice.naru.pub/vendor/purify.es.mjs"),
    env({ "alice/vendor/purify.es.mjs": "export default {};" }),
    "alice",
    ctx,
    () => {},
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/javascript");
  expect(await response.text()).toBe("export default {};");
  await ctx.settled();
});
