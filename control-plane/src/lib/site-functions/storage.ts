import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { s3Client } from "@/lib/s3";
import type { RevisionBucket } from "./revisions";
import type { RestorePointBucket } from "./restore-points";
// The site bucket, and the private one, which no public domain serves, where
// Naru keeps `_naru-runtime/<site>/` (releases, routes.json and restore
// points) and each site's code, `<site>/_naru/`: named as the site bucket's,
// the S3 client keeps it there (site-code-bucket.ts).
const siteBucket = () => process.env.S3_BUCKET_NAME!;
const privateBucket = () => process.env.S3_PRIVATE_BUCKET_NAME!;
const objectStorage = (bucket: () => string): RevisionBucket => ({
  async list({ prefix, cursor }) {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: cursor,
      }),
    );
    return {
      objects: (page.Contents ?? []).map((object) => ({
        key: object.Key!,
        etag: object.ETag!,
        size: object.Size!,
      })),
      truncated: !!page.IsTruncated,
      cursor: page.NextContinuationToken,
    };
  },
  async get(key) {
    try {
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket(), Key: key }),
      );
      return {
        etag: object.ETag!,
        size: object.ContentLength!,
        text: () => object.Body!.transformToString(),
      };
    } catch (error: any) {
      if (error.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  },
  async put(key, source, options) {
    return s3Client.send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: source,
        ...(options ? { IfNoneMatch: "*" } : {}),
      }),
    );
  },
});
export const siteStorage = objectStorage(siteBucket);
export const runtimeStorage = objectStorage(privateBucket);
/** Deletes every key under `prefix` in the private bucket, a page at a time. */
async function deletePrivatePrefix(
  prefix: string,
  heartbeat: () => Promise<void>,
  failure: string,
) {
  let cursor: string | undefined;
  do {
    const page = await runtimeStorage.list({ prefix, cursor });
    await heartbeat();
    if (page.objects.length) {
      const response = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: privateBucket(),
          Delete: { Objects: page.objects.map(({ key }) => ({ Key: key })) },
        }),
      );
      if (response.Errors?.length)
        throw new Error(`${failure}: ${response.Errors[0].Code}`);
      await heartbeat();
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function deleteRevision(
  site: string,
  revision: string,
  heartbeat: () => Promise<void>,
) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(site) || !/^[a-f0-9]{64}$/.test(revision))
    throw new Error("Invalid revision cleanup target");
  await deletePrivatePrefix(
    `_naru-runtime/${site}/revisions/${revision}/`,
    heartbeat,
    "Revision deletion failed",
  );
}

/**
 * Everything Naru keeps for a site, `_naru-runtime/<site>/` (its releases,
 * routes.json and restore points), when its account is deleted.
 */
export async function deleteSiteRuntime(site: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(site))
    throw new Error("Invalid site cleanup target");
  await deletePrivatePrefix(
    `_naru-runtime/${site}/`,
    async () => {},
    "Deleting the site's runtime files failed",
  );
}

/**
 * The private bucket as restore-point pruning needs it (restore-points.ts):
 * listed with upload times, deleted a batch at a time.
 */
export const restorePointStorage: RestorePointBucket = {
  async list({ prefix, cursor }) {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: privateBucket(),
        Prefix: prefix,
        ContinuationToken: cursor,
      }),
    );
    return {
      objects: (page.Contents ?? []).map((object) => ({
        key: object.Key!,
        uploaded: object.LastModified,
      })),
      truncated: !!page.IsTruncated,
      cursor: page.NextContinuationToken,
    };
  },
  async delete(keys) {
    if (!keys.length) return;
    const response = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: privateBucket(),
        Delete: { Objects: keys.map((key) => ({ Key: key })) },
      }),
    );
    if (response.Errors?.length)
      throw new Error(
        `Deleting restore points failed: ${response.Errors[0].Key} ${response.Errors[0].Code}`,
      );
  },
};

/**
 * A restore point's bytes as R2 streams them, for the owner to download:
 * never read whole here. Null when there is no such object.
 */
export async function openRestorePoint(
  key: string,
): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
  try {
    const object = await s3Client.send(
      new GetObjectCommand({ Bucket: privateBucket(), Key: key }),
    );
    return {
      body: object.Body!.transformToWebStream() as ReadableStream<Uint8Array>,
      size: object.ContentLength!,
    };
  } catch (error: any) {
    if (error.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

/** The site names with a `_naru-runtime/<site>/` folder in the bucket. */
export async function runtimeSites(): Promise<string[]> {
  const sites: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: privateBucket(),
        Prefix: "_naru-runtime/",
        Delimiter: "/",
        ContinuationToken: cursor,
      }),
    );
    for (const { Prefix } of page.CommonPrefixes ?? []) {
      const site = Prefix?.slice("_naru-runtime/".length, -1);
      if (site && /^[a-zA-Z0-9_-]{1,64}$/.test(site)) sites.push(site);
    }
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (cursor);
  return sites;
}
