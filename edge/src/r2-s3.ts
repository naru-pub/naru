import { AwsClient } from "aws4fetch";

// The site bucket through R2's S3 API, where there is no R2 binding: the
// Worker under workerd on the mini (seoul.ts). Only what SiteData uses: list,
// get, put (optionally only where nothing is yet) and delete, shaped as the
// binding answers them.

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
        objects: elements(xml, "Contents").map((object) => ({
          key: text(object, "Key")!,
          etag: text(object, "ETag")!,
          size: Number(text(object, "Size")),
        })),
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
      };
    },
    async put(
      key: string,
      body: string,
      options?: { onlyIf?: { etagDoesNotMatch?: string } },
    ) {
      const response = await client.fetch(url(key), {
        method: "PUT",
        body,
        headers:
          options?.onlyIf?.etagDoesNotMatch === "*"
            ? { "If-None-Match": "*" }
            : {},
      });
      // The binding answers null when the condition fails.
      if (response.status === 412) return null;
      if (!response.ok) throw failed(`a write of ${key}`, response);
      return { key };
    },
    async delete(key: string) {
      const response = await client.fetch(url(key), { method: "DELETE" });
      if (!response.ok && response.status !== 404)
        throw failed(`a deletion of ${key}`, response);
    },
  };
}
