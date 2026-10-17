import { AwsClient } from "aws4fetch";

// The site bucket through R2's S3 API, where there is no R2 binding: the
// Worker under workerd on the mini (seoul.ts). Only what SiteData uses: list
// (with upload times), get (as text or a stream), put (optionally only where
// nothing is yet, optionally with a content type), delete (a key or several)
// and multipart uploads (dumps, dump.ts), shaped as the binding answers them.

export interface S3Env {
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};
/** Each <tag>…</tag> in a ListObjectsV2 answer, as raw XML. */
const elements = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (match) => match[1],
  );
/** The text of the first <tag>, entities decoded, or undefined. */
const text = (xml: string, tag: string) =>
  elements(xml, tag)[0]?.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (entity) => ENTITIES[entity],
  );

/** The Content-Type header for a binding's httpMetadata, if any. */
const contentType = (options?: {
  httpMetadata?: { contentType?: string };
}): Record<string, string> =>
  options?.httpMetadata?.contentType
    ? { "Content-Type": options.httpMetadata.contentType }
    : {};

export function s3Bucket(env: S3Env) {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
    // aws4fetch retries a 5xx ten times by default; a function call waiting on
    // its sources should fail soon instead.
    retries: 2,
  });
  const base = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}`;
  const url = (key: string) =>
    `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const failed = (what: string, response: Response) =>
    new Error(`R2 answered ${response.status} to ${what}`);
  return {
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const query = new URLSearchParams({ "list-type": "2", prefix });
      if (cursor) query.set("continuation-token", cursor);
      const response = await client.fetch(`${base}?${query}`);
      if (!response.ok) throw failed(`a list of ${prefix}`, response);
      const xml = await response.text();
      return {
        objects: elements(xml, "Contents").map((object) => {
          const modified = text(object, "LastModified");
          return {
            key: text(object, "Key")!,
            etag: text(object, "ETag")!,
            size: Number(text(object, "Size")),
            ...(modified ? { uploaded: new Date(modified) } : {}),
          };
        }),
        truncated: text(xml, "IsTruncated") === "true",
        cursor: text(xml, "NextContinuationToken"),
      };
    },
    async get(key: string) {
      const response = await client.fetch(url(key));
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
      const headers: Record<string, string> = contentType(options);
      if (options?.onlyIf?.etagDoesNotMatch === "*")
        headers["If-None-Match"] = "*";
      const response = await client.fetch(url(key), {
        method: "PUT",
        body,
        headers,
      });
      // The binding answers null when the condition fails.
      if (response.status === 412) return null;
      if (!response.ok) throw failed(`a write of ${key}`, response);
      return { key };
    },
    /** As the binding's: parts of at least 5 MiB, all but the last the same size. */
    async createMultipartUpload(
      key: string,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      const created = await client.fetch(`${url(key)}?uploads`, {
        method: "POST",
        headers: contentType(options),
      });
      if (!created.ok) throw failed(`a multipart upload of ${key}`, created);
      const uploadId = text(await created.text(), "UploadId");
      if (!uploadId) throw new Error(`R2 gave no upload ID for ${key}`);
      const at = (query: Record<string, string>) =>
        `${url(key)}?${new URLSearchParams(query)}`;
      return {
        key,
        uploadId,
        async uploadPart(partNumber: number, value: Uint8Array) {
          const response = await client.fetch(
            at({ partNumber: String(partNumber), uploadId }),
            { method: "PUT", body: value },
          );
          if (!response.ok)
            throw failed(`part ${partNumber} of ${key}`, response);
          return { partNumber, etag: response.headers.get("etag") ?? "" };
        },
        async complete(parts: { partNumber: number; etag: string }[]) {
          const xml = `<CompleteMultipartUpload>${parts
            .map(
              (part) =>
                `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag
                  .replaceAll("&", "&amp;")
                  .replaceAll("<", "&lt;")
                  .replaceAll(">", "&gt;")
                  .replaceAll('"', "&quot;")}</ETag></Part>`,
            )
            .join("")}</CompleteMultipartUpload>`;
          const response = await client.fetch(at({ uploadId }), {
            method: "POST",
            body: xml,
          });
          // S3 can answer 200 with an error in the body.
          const answer = response.ok ? await response.text() : "";
          if (!response.ok || /<Error>/.test(answer))
            throw failed(`completing ${key}`, response);
          return { key };
        },
        async abort() {
          const response = await client.fetch(at({ uploadId }), {
            method: "DELETE",
          });
          if (!response.ok && response.status !== 404)
            throw failed(`aborting ${key}`, response);
        },
      };
    },
    /** One key, or several, one request each, as callers batch them. */
    async delete(keys: string | string[]) {
      for (const key of typeof keys === "string" ? [keys] : keys) {
        const response = await client.fetch(url(key), { method: "DELETE" });
        if (!response.ok && response.status !== 404)
          throw failed(`a deletion of ${key}`, response);
      }
    },
  };
}
