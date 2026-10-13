import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { s3Client } from "@/lib/s3";
import type { RevisionBucket } from "./revisions";
const bucket = () => process.env.S3_BUCKET_NAME!;
export const revisionStorage: RevisionBucket = {
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
};
export async function deleteRevision(
  site: string,
  revision: string,
  heartbeat: () => Promise<void>,
) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(site) || !/^[a-f0-9]{64}$/.test(revision))
    throw new Error("Invalid revision cleanup target");
  const prefix = `_naru-runtime/${site}/revisions/${revision}/`;
  let cursor: string | undefined;
  do {
    const page = await revisionStorage.list({ prefix, cursor });
    await heartbeat();
    if (page.objects.length) {
      const response = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: { Objects: page.objects.map(({ key }) => ({ Key: key })) },
        }),
      );
      if (response.Errors?.length)
        throw new Error(`Revision deletion failed: ${response.Errors[0].Code}`);
      await heartbeat();
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
