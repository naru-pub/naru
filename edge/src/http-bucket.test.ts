import { afterEach, describe, expect, test, vi } from "vitest";
import { httpBucket } from "./http-bucket";

const env = {
  SITE_BUCKET_URL: "http://localhost:4000/_naru-dev/bucket/",
  EDGE_WORKER_SECRET: "secret",
};
const BASE = "http://localhost:4000/_naru-dev/bucket";

/** Answers each request with the next response, keeping what was asked. */
function answering(...responses: Response[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return responses.shift()!;
    }),
  );
  return seen;
}
afterEach(() => vi.unstubAllGlobals());

describe("the site bucket as a local HTTP store", () => {
  test("lists a page with upload times as dates", async () => {
    const seen = answering(
      Response.json({
        objects: [
          {
            key: "a/_naru/queries/x y.js",
            size: 3,
            etag: "e",
            uploaded: "2026-10-10T01:02:03.000Z",
          },
        ],
        truncated: true,
        cursor: "next",
      }),
    );
    const page = await httpBucket(env).list({ prefix: "a/", cursor: "c" });
    expect(seen[0].url).toBe(`${BASE}/list?prefix=a%2F&cursor=c`);
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret",
    );
    expect(page.objects[0].uploaded).toEqual(
      new Date("2026-10-10T01:02:03.000Z"),
    );
    expect(page).toMatchObject({ truncated: true, cursor: "next" });
  });

  test("reads, and answers null for a missing key", async () => {
    answering(
      new Response("hello", { headers: { etag: "e1" } }),
      new Response(null, { status: 404 }),
    );
    const bucket = httpBucket(env);
    expect(await (await bucket.get("a/b.js"))!.text()).toBe("hello");
    expect(await bucket.get("a/missing.js")).toBeNull();
  });

  test("puts only where nothing is, when asked", async () => {
    const seen = answering(new Response(null, { status: 412 }));
    expect(
      await httpBucket(env).put("a/b c.js", "x", {
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    ).toBeNull();
    expect(seen[0].url).toBe(`${BASE}/objects/a/b%20c.js`);
    expect(
      (seen[0].init.headers as Record<string, string>)["if-none-match"],
    ).toBe("*");
  });

  test("writes a multipart upload whole, its parts in order", async () => {
    const seen = answering(new Response(null, { status: 200 }));
    const upload = await httpBucket(env).createMultipartUpload("a/dump.gz");
    const second = await upload.uploadPart(2, new Uint8Array([3, 4]));
    const first = await upload.uploadPart(1, new Uint8Array([1, 2]));
    await upload.complete([first, second]);
    expect(seen).toHaveLength(1);
    expect([...(seen[0].init.body as Uint8Array)]).toEqual([1, 2, 3, 4]);
  });
});
