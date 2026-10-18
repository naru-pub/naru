// The site bucket as a plain HTTP store, for local runs without R2: naru-dev
// (../naru-dev) serves one from a folder and gives the Worker its address as
// SITE_BUCKET_URL (seoul.ts). The same surface as r2-s3.ts, which is what
// SiteData uses of the binding:
//
//   GET    <base>/objects/<key>             the object, or 404
//   PUT    <base>/objects/<key>             write; If-None-Match: * fails with
//                                           412 when it exists
//   DELETE <base>/objects/<key>
//   GET    <base>/list?prefix=&cursor=      { objects: [{ key, size, etag,
//                                           uploaded }], truncated, cursor }
//
// each with the Worker's secret as a bearer token. Multipart uploads (dumps)
// are kept in memory and written whole on completion.

export interface HttpBucketEnv {
  SITE_BUCKET_URL: string;
  EDGE_WORKER_SECRET: string;
}

export function httpBucket(env: HttpBucketEnv) {
  const base = env.SITE_BUCKET_URL.replace(/\/$/, "");
  const authorization = `Bearer ${env.EDGE_WORKER_SECRET}`;
  const url = (key: string) =>
    `${base}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
  const call = (target: string, init: RequestInit = {}) =>
    fetch(target, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization },
    });
  const failed = (what: string, response: Response) =>
    new Error(`The local bucket answered ${response.status} to ${what}`);
  const bucket = {
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const query = new URLSearchParams({ prefix });
      if (cursor) query.set("cursor", cursor);
      const response = await call(`${base}/list?${query}`);
      if (!response.ok) throw failed(`a list of ${prefix}`, response);
      const page = (await response.json()) as {
        objects: {
          key: string;
          size: number;
          etag: string;
          uploaded: string;
        }[];
        truncated: boolean;
        cursor?: string;
      };
      return {
        objects: page.objects.map((object) => ({
          ...object,
          uploaded: new Date(object.uploaded),
        })),
        truncated: page.truncated,
        cursor: page.cursor,
      };
    },
    async get(key: string) {
      const response = await call(url(key));
      if (response.status === 404) return null;
      if (!response.ok) throw failed(`a read of ${key}`, response);
      return {
        key,
        etag: response.headers.get("etag") ?? "",
        size: Number(response.headers.get("content-length")),
        text: () => response.text(),
        body: response.body!,
      };
    },
    async put(
      key: string,
      body: string | Uint8Array,
      options?: {
        onlyIf?: { etagDoesNotMatch?: string };
        httpMetadata?: { contentType?: string };
      },
    ) {
      const headers: Record<string, string> = {};
      if (options?.httpMetadata?.contentType)
        headers["content-type"] = options.httpMetadata.contentType;
      if (options?.onlyIf?.etagDoesNotMatch === "*")
        headers["if-none-match"] = "*";
      const response = await call(url(key), { method: "PUT", body, headers });
      // The binding answers null when the condition fails.
      if (response.status === 412) return null;
      if (!response.ok) throw failed(`a write of ${key}`, response);
      return { key };
    },
    async createMultipartUpload(
      key: string,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      const parts = new Map<number, Uint8Array>();
      return {
        key,
        uploadId: crypto.randomUUID(),
        async uploadPart(partNumber: number, value: Uint8Array) {
          parts.set(partNumber, value.slice());
          return { partNumber, etag: String(partNumber) };
        },
        async complete(order: { partNumber: number; etag: string }[]) {
          const pieces = order.map((part) => parts.get(part.partNumber)!);
          const whole = new Uint8Array(
            pieces.reduce((sum, piece) => sum + piece.byteLength, 0),
          );
          let at = 0;
          for (const piece of pieces) {
            whole.set(piece, at);
            at += piece.byteLength;
          }
          parts.clear();
          await bucket.put(key, whole, options);
          return { key };
        },
        async abort() {
          parts.clear();
        },
      };
    },
    async delete(keys: string | string[]) {
      for (const key of typeof keys === "string" ? [keys] : keys) {
        const response = await call(url(key), { method: "DELETE" });
        if (!response.ok && response.status !== 404)
          throw failed(`a deletion of ${key}`, response);
      }
    },
  };
  return bucket;
}
