import { describe, expect, test } from "vitest";
import {
  matchRoute,
  routeAnswer,
  validRoute,
  withHead,
} from "../../control-plane/src/lib/site-functions/routes";
import { servePage, type PagesEnv, type RenderRoute } from "./pages";

// Routes (1.1.0): which path a route answers, what it may answer, and the
// page Worker serving it, against a bucket held in memory and a stand-in for
// the site's object.

describe("matching", () => {
  const routes = [
    "index",
    "about",
    "posts/index",
    "posts/_id",
    "posts/new",
    "boards/_board/_post",
    "feed.xml",
  ];
  test("a path finds its route, fixed segments before parameters", () => {
    expect(matchRoute(routes, "/")).toEqual({ route: "index", params: {} });
    expect(matchRoute(routes, "/about")).toEqual({
      route: "about",
      params: {},
    });
    expect(matchRoute(routes, "/posts")).toEqual({
      route: "posts/index",
      params: {},
    });
    expect(matchRoute(routes, "/posts/")).toEqual({
      route: "posts/index",
      params: {},
    });
    expect(matchRoute(routes, "/posts/42")).toEqual({
      route: "posts/_id",
      params: { id: "42" },
    });
    expect(matchRoute(routes, "/posts/new")).toEqual({
      route: "posts/new",
      params: {},
    });
    expect(matchRoute(routes, "/posts/%EA%B8%80")).toEqual({
      route: "posts/_id",
      params: { id: "글" },
    });
    expect(matchRoute(routes, "/feed.xml")).toEqual({
      route: "feed.xml",
      params: {},
    });
    expect(matchRoute(routes, "/boards/free/7")).toEqual({
      route: "boards/_board/_post",
      params: { board: "free", post: "7" },
    });
  });
  test("other paths are the site's files", () => {
    for (const path of ["/about/", "/posts/42/x", "/style.css", "/%E0%A4%A"])
      expect(matchRoute(routes, path)).toBeNull();
    expect(matchRoute([], "/")).toBeNull();
  });
});

describe("answers", () => {
  test("HTML, a file with a head, or a redirect, with a status and cache", () => {
    expect(routeAnswer("<p>hi</p>")).toEqual({
      status: 200,
      cache: 0,
      html: "<p>hi</p>",
    });
    expect(routeAnswer({ html: "x", status: 404, cache: 60 })).toEqual({
      status: 404,
      cache: 60,
      html: "x",
    });
    expect(
      routeAnswer({ file: "/index.html", head: "<title>t</title>" }),
    ).toEqual({
      status: 200,
      cache: 0,
      file: "index.html",
      head: "<title>t</title>",
    });
    expect(routeAnswer({ redirect: "/posts/1" })).toEqual({
      status: 302,
      cache: 0,
      redirect: "/posts/1",
    });
  });
  test("text such as a feed, as one of the types that cannot run as the site", () => {
    expect(
      routeAnswer({ body: "<rss/>", type: "application/rss+xml", cache: 300 }),
    ).toEqual({
      status: 200,
      cache: 300,
      body: "<rss/>",
      type: "application/rss+xml",
    });
    for (const type of [
      "text/html",
      "image/svg+xml",
      "application/javascript",
      undefined,
    ])
      expect(() => routeAnswer({ body: "x", type })).toThrow(
        /whose type is not one of/,
      );
    expect(validRoute("feed.xml")).toBe(true);
    expect(validRoute("posts/_id")).toBe(true);
    for (const route of ["..", "a/./b", "a b", "a/", ""])
      expect(validRoute(route), route).toBe(false);
  });

  test("anything else is the route's mistake", () => {
    for (const value of [
      null,
      42,
      {},
      { html: "x", status: 700 },
      { html: "x", cache: 3600 },
      { file: "../alice/index.html" },
      { redirect: "//evil.example" },
      { redirect: "/x", status: 200 },
    ])
      expect(() => routeAnswer(value), JSON.stringify(value)).toThrow(
        /The route answered/,
      );
  });
  test("a head goes inside the file's <head>", () => {
    expect(
      withHead("<html><head><title>a</title></HEAD><body>", "<meta x>"),
    ).toBe("<html><head><title>a</title><meta x></HEAD><body>");
    expect(withHead("<p>no head</p>", "<meta x>")).toBe(
      "<meta x><p>no head</p>",
    );
  });
});

describe("serving", () => {
  const files: Record<string, string> = {
    "_naru-runtime/carol/routes.json": JSON.stringify({
      routes: ["posts/_id", "go"],
    }),
    "carol/index.html":
      "<html><head><title>앱</title></head><body>app</body></html>",
    "carol/about.html": "about",
  };
  const env: PagesEnv = {
    PLATFORM_DOMAIN: "naru.pub",
    R2_PUBLIC_DOMAIN: "r2.naru.pub",
    SITE_FILES: {
      async get(key: string) {
        if (!(key in files)) return null;
        return {
          size: files[key].length,
          httpMetadata: { contentType: "text/html" },
          body: new Response(files[key]).body,
          json: async () => JSON.parse(files[key]),
        };
      },
    } as unknown as R2Bucket,
  };
  const ctx = { waitUntil: () => {} };
  const asked: Parameters<RenderRoute>[0][] = [];
  let answer: Awaited<ReturnType<RenderRoute>>;
  const render: RenderRoute = async (input) => {
    asked.push(input);
    return answer;
  };
  const get = (path: string) =>
    servePage(
      new Request(`https://carol.naru.pub${path}`),
      env,
      "carol",
      ctx,
      () => {},
      render,
    );

  test("a route's page, its parameters and query, never cached unless asked", async () => {
    answer = { ok: true, value: { result: "<h1>글 42</h1>" } };
    const page = await get("/posts/42?tab=comments");
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<h1>글 42</h1>");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(asked.at(-1)).toMatchObject({
      site: "carol",
      route: "posts/_id",
      path: "/posts/42",
      params: { id: "42" },
      query: { tab: "comments" },
    });
  });

  test("a file with the route's head, for link previews", async () => {
    answer = {
      ok: true,
      value: {
        result: {
          file: "index.html",
          head: '<meta property="og:title" content="글">',
        },
      },
    };
    expect(await (await get("/posts/42")).text()).toBe(
      '<html><head><title>앱</title><meta property="og:title" content="글"></head><body>app</body></html>',
    );
  });

  test("a feed with its own type", async () => {
    answer = {
      ok: true,
      value: { result: { body: "<rss/>", type: "application/rss+xml" } },
    };
    const feed = await get("/go");
    expect(feed.headers.get("Content-Type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    expect(feed.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await feed.text()).toBe("<rss/>");
  });

  test("redirects, refusals, and the files when the site's object is away", async () => {
    answer = {
      ok: true,
      value: { result: { redirect: "/posts/1", status: 301 } },
    };
    const moved = await get("/go");
    expect([moved.status, moved.headers.get("Location")]).toEqual([
      301,
      "/posts/1",
    ]);
    answer = {
      ok: false,
      error: { status: 404, message: "그런 글은 없어요 <b>" },
    };
    const missing = await get("/posts/9");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("그런 글은 없어요 &#60;b&#62;");
    // Unavailable: the path is served as a file, as it would be without routes.
    answer = { ok: false, error: { status: 503, message: "away" } };
    expect((await get("/go")).status).toBe(404);
    // Paths no route matches never reach the object.
    const before = asked.length;
    expect(await (await get("/about.html")).text()).toBe("about");
    expect(asked.length).toBe(before);
  });
});
