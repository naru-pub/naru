import { afterEach, describe, expect, test, vi } from "vitest";
import { s3Bucket } from "./r2-s3";

const env = {
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "naru-pub",
  R2_PRIVATE_BUCKET: "naru-private",
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
          <Contents><Key>a/_naru/queries/x&amp;y.js</Key><ETag>&quot;e1&quot;</ETag><Size>12</Size></Contents>
          <Contents><Key>a/_naru/queries/z.js</Key><LastModified>2026-10-10T01:02:03.000Z</LastModified><ETag>&quot;e2&quot;</ETag><Size>3</Size></Contents>
          <NextContinuationToken>next+page</NextContinuationToken>
        </ListBucketResult>`,
      ),
    );
    const page = await s3Bucket(env).list({
      prefix: "a/_naru/queries/",
      cursor: "this",
    });
    expect(page).toEqual({
      objects: [
        { key: "a/_naru/queries/x&y.js", etag: '"e1"', size: 12 },
        {
          key: "a/_naru/queries/z.js",
          etag: '"e2"',
          size: 3,
          uploaded: new Date("2026-10-10T01:02:03.000Z"),
        },
      ],
      truncated: true,
      cursor: "next+page",
    });
    const url = new URL(seen[0].url);
    expect(url.origin + url.pathname).toBe(BASE);
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(url.searchParams.get("prefix")).toBe("a/_naru/queries/");
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
    const found = await bucket.get("a/_naru/queries/x.js");
    expect(found).toMatchObject({ etag: '"e1"', size: 19 });
    expect(await found!.text()).toBe("export const x = 1;");
    expect(await bucket.get("a/_naru/queries/gone.js")).toBeNull();
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

  test("stores the content type it is given, and no encoding", async () => {
    const seen = answering(
      new Response(null, { status: 200 }),
      new Response(
        `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>u</UploadId></InitiateMultipartUploadResult>`,
      ),
    );
    const bucket = s3Bucket(env);
    const gzip = { httpMetadata: { contentType: "application/gzip" } };
    await bucket.put("s/r/a.ndjson.gz", new Uint8Array([31, 139]), gzip);
    await bucket.createMultipartUpload("s/r/b.ndjson.gz", gzip);
    for (const request of seen) {
      expect(request.headers.get("content-type")).toBe("application/gzip");
      expect(request.headers.get("content-encoding")).toBeNull();
    }
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
    await bucket.delete("a/_naru/queries/x.js");
    await expect(bucket.delete("a/_naru/queries/x.js")).rejects.toThrow(
      "R2 answered 500",
    );
  });

  test("deletes several keys, one request each", async () => {
    const seen = answering(
      new Response(null, { status: 204 }),
      new Response(null, { status: 404 }),
    );
    await s3Bucket(env).delete(["s/r/a.json", "s/r/b.json"]);
    expect(seen.map((request) => [request.method, request.url])).toEqual([
      ["DELETE", `${BASE}/s/r/a.json`],
      ["DELETE", `${BASE}/s/r/b.json`],
    ]);
  });

  test("uploads in parts as the binding does: create, parts, complete, abort", async () => {
    const seen = answering(
      new Response(
        `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>up&amp;1</UploadId></InitiateMultipartUploadResult>`,
      ),
      new Response(null, { headers: { etag: '"p1"' } }),
      new Response(null, { headers: { etag: '"p2"' } }),
      new Response("<CompleteMultipartUploadResult/>"),
      new Response(null, { status: 204 }),
    );
    const upload = await s3Bucket(env).createMultipartUpload("s/r/a.ndjson");
    expect(upload.uploadId).toBe("up&1");
    const one = await upload.uploadPart(1, new Uint8Array([1, 2]));
    const two = await upload.uploadPart(2, new Uint8Array([3]));
    expect([one, two]).toEqual([
      { partNumber: 1, etag: '"p1"' },
      { partNumber: 2, etag: '"p2"' },
    ]);
    await upload.complete([one, two]);
    await upload.abort();
    expect(seen.map((request) => request.method)).toEqual([
      "POST",
      "PUT",
      "PUT",
      "POST",
      "DELETE",
    ]);
    expect(seen[0].url).toBe(`${BASE}/s/r/a.ndjson?uploads`);
    const part = new URL(seen[1].url);
    expect(part.searchParams.get("partNumber")).toBe("1");
    expect(part.searchParams.get("uploadId")).toBe("up&1");
    expect(new Uint8Array(await seen[1].arrayBuffer())).toEqual(
      new Uint8Array([1, 2]),
    );
    expect(await seen[3].text()).toBe(
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;p1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;p2&quot;</ETag></Part></CompleteMultipartUpload>",
    );
    expect(new URL(seen[4].url).searchParams.get("uploadId")).toBe("up&1");
  });

  test("reads a file as a stream", async () => {
    answering(new Response("{}\n"));
    const found = await s3Bucket(env).get("s/r/a.ndjson");
    expect(await new Response(found!.body).text()).toBe("{}\n");
  });
});
