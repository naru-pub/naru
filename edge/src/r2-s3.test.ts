import { afterEach, describe, expect, test, vi } from "vitest";
import { s3Bucket } from "./r2-s3";

const env = {
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "naru-pub",
};
const BASE = "https://account.r2.cloudflarestorage.com/naru-pub";

/** Answers each request with the next response, keeping what was asked. */
function answering(...responses: Response[]) {
  const seen: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      seen.push(request);
      return responses.shift()!;
    }),
  );
  return seen;
}
afterEach(() => vi.unstubAllGlobals());

describe("the site bucket through R2's S3 API", () => {
  test("lists a page of keys, with entities decoded and the next cursor", async () => {
    const seen = answering(
      new Response(
        `<?xml version="1.0"?><ListBucketResult>
          <IsTruncated>true</IsTruncated>
          <Contents><Key>a/_naru/functions/x&amp;y.js</Key><ETag>&quot;e1&quot;</ETag><Size>12</Size></Contents>
          <Contents><Key>a/_naru/functions/z.js</Key><ETag>&quot;e2&quot;</ETag><Size>3</Size></Contents>
          <NextContinuationToken>next+page</NextContinuationToken>
        </ListBucketResult>`,
      ),
    );
    const page = await s3Bucket(env).list({
      prefix: "a/_naru/functions/",
      cursor: "this",
    });
    expect(page).toEqual({
      objects: [
        { key: "a/_naru/functions/x&y.js", etag: '"e1"', size: 12 },
        { key: "a/_naru/functions/z.js", etag: '"e2"', size: 3 },
      ],
      truncated: true,
      cursor: "next+page",
    });
    const url = new URL(seen[0].url);
    expect(url.origin + url.pathname).toBe(BASE);
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(url.searchParams.get("prefix")).toBe("a/_naru/functions/");
    expect(url.searchParams.get("continuation-token")).toBe("this");
    // Signed for R2's S3 endpoint.
    expect(seen[0].headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=key\/\d{8}\/auto\/s3\/aws4_request/,
    );
  });

  test("reads a file, and answers null for one that is not there", async () => {
    answering(
      new Response("export const x = 1;", {
        headers: { etag: '"e1"', "content-length": "19" },
      }),
      new Response("", { status: 404 }),
    );
    const bucket = s3Bucket(env);
    const found = await bucket.get("a/_naru/functions/x.js");
    expect(found).toMatchObject({ etag: '"e1"', size: 19 });
    expect(await found!.text()).toBe("export const x = 1;");
    expect(await bucket.get("a/_naru/functions/gone.js")).toBeNull();
  });

  test("writes only where nothing is yet, answering null as the binding does", async () => {
    const seen = answering(
      new Response(null, { status: 200 }),
      new Response(null, { status: 412 }),
    );
    const bucket = s3Bucket(env);
    expect(
      await bucket.put("r/manifest.json", "{}", {
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    ).toEqual({ key: "r/manifest.json" });
    expect(
      await bucket.put("r/manifest.json", "{}", {
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    ).toBeNull();
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].headers.get("if-none-match")).toBe("*");
    expect(seen[0].url).toBe(`${BASE}/r/manifest.json`);
  });

  test("deletes, and refuses to hide a failure", async () => {
    answering(
      new Response(null, { status: 204 }),
      // The first try and two retries.
      new Response(null, { status: 500 }),
      new Response(null, { status: 500 }),
      new Response(null, { status: 500 }),
    );
    const bucket = s3Bucket(env);
    await bucket.delete("a/_naru/functions/x.js");
    await expect(bucket.delete("a/_naru/functions/x.js")).rejects.toThrow(
      "R2 answered 500",
    );
  });
});
