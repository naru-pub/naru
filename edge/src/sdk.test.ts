import { describe, expect, test } from "vitest";
import { SDK_CACHE, sdkAsset, serveSdk, type SdkEnv } from "./sdk";

// The Worker's assets binding, held in memory: it answers a matching
// If-None-Match with a 304, as the real one does.
const env = (files: Record<string, string>): SdkEnv => ({
  SDK_FILES: {
    async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      if (!(path in files)) return new Response("missing", { status: 404 });
      const etag = `"${path}"`;
      if (request.headers.get("if-none-match") === etag)
        return new Response(null, { status: 304, headers: { ETag: etag } });
      return new Response(request.method === "HEAD" ? null : files[path], {
        headers: { ETag: etag, "Content-Type": "video/mp2t" },
      });
    },
  } as unknown as Fetcher,
});

const files = env({
  "/1.0.0/naru.js": "export const createNaru = 0;",
  "/1.0.0/naru.d.ts": "export declare const createNaru: number;",
  "/1.1.0/naru.js": "export const createNaru = 1;",
  "/1.1.0/naru.d.ts": "export declare const createNaru: number;",
  "/1.1.0/functions.d.ts": "export interface Ctx {}",
});
const get = (path: string, init?: RequestInit) =>
  serveSdk(new Request(`https://naru.pub${path}`, init), files);

describe("paths", () => {
  test("names a release's files, through its line's alias too", () => {
    expect(sdkAsset("/sdk/1.1.0/naru.js")).toBe("/1.1.0/naru.js");
    expect(sdkAsset("/sdk/1.0.0/naru.js")).toBe("/1.0.0/naru.js");
    expect(sdkAsset("/sdk/1/naru.js")).toBe("/1.0.0/naru.js");
    expect(sdkAsset("/sdk/1/naru.d.ts")).toBe("/1.0.0/naru.d.ts");
  });

  test("names nothing else", () => {
    for (const path of [
      "/sdk/naru.js",
      "/sdk/1.0.0/",
      "/sdk/1.0.0/other.js",
      "/sdk/1.0/naru.js",
      "/sdk/../1.0.0/naru.js",
      "/sdk/1.0.0/naru.js/x",
      "/sdk/latest/naru.js",
      "/sdk/constructor/naru.js",
    ])
      expect(sdkAsset(path), path).toBeNull();
  });
});

describe("serving", () => {
  test("serves the module as a cross-origin, revalidated script", async () => {
    const response = await get("/sdk/1/naru.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export const createNaru = 0;");
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "text/javascript; charset=utf-8",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "cache-control": SDK_CACHE,
      etag: '"/1.0.0/naru.js"',
    });
  });

  test("serves declarations as text", async () => {
    for (const path of ["/sdk/1.0.0/naru.d.ts", "/sdk/1.1.0/functions.d.ts"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/plain; charset=utf-8",
      );
    }
    // 1.0.0 has no functions to describe.
    expect((await get("/sdk/1.0.0/functions.d.ts")).status).toBe(404);
  });

  test("answers a revalidation with 304", async () => {
    const response = await get("/sdk/1/naru.js", {
      headers: { "If-None-Match": '"/1.0.0/naru.js"' },
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("cache-control")).toBe(SDK_CACHE);
  });

  test("is not found for a release it does not have", async () => {
    expect((await get("/sdk/9.9.9/naru.js")).status).toBe(404);
    expect((await get("/sdk/2/naru.js")).status).toBe(404);
  });

  test("only reads", async () => {
    expect((await get("/sdk/1/naru.js", { method: "HEAD" })).status).toBe(200);
    expect((await get("/sdk/1/naru.js", { method: "POST" })).status).toBe(405);
  });
});
