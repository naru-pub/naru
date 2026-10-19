import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { s3Client } from "@/lib/s3";

// Naru's own files beside the sites, `_naru-runtime/<site>/` (function
// revisions, routes.json, restore points), used to live in the site bucket,
// where r2.naru.pub served them to anyone who knew a key. They now live in
// the private bucket, under the same keys. This copies them across: an
// object the private bucket lacks, or has an older copy of (routes.json is
// rewritten in place), so a run after the release that reads the private
// bucket keeps what that release wrote. Safe to run again.
//
// With --delete, it instead deletes from the site bucket each object the
// private bucket holds a copy of, as large and no older; anything else is
// reported and left.
//
//   node dist/cli/move-runtime-to-private-bucket.mjs [--delete]
const PREFIX = "_naru-runtime/";

type Listed = { key: string; size: number; modified: number };

async function list(bucket: string) {
  const objects = new Map<string, Listed>();
  let cursor: string | undefined;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: PREFIX,
        ContinuationToken: cursor,
      }),
    );
    for (const object of page.Contents ?? [])
      objects.set(object.Key!, {
        key: object.Key!,
        size: object.Size ?? 0,
        modified: object.LastModified?.getTime() ?? 0,
      });
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (cursor);
  return objects;
}

async function main() {
  const from = process.env.S3_BUCKET_NAME;
  const to = process.env.S3_PRIVATE_BUCKET_NAME;
  if (!from || !to)
    throw new Error("S3_BUCKET_NAME and S3_PRIVATE_BUCKET_NAME must be set");
  const remove = process.argv.includes("--delete");
  const [source, copies] = await Promise.all([list(from), list(to)]);

  if (remove) {
    const deletable: string[] = [];
    for (const object of source.values()) {
      const copy = copies.get(object.key);
      if (copy && copy.size === object.size && copy.modified >= object.modified)
        deletable.push(object.key);
      else
        console.log(
          `[move-runtime-to-private-bucket] keeping ${object.key}: no copy as new`,
        );
    }
    for (let offset = 0; offset < deletable.length; offset += 1000) {
      const response = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: from,
          Delete: {
            Objects: deletable
              .slice(offset, offset + 1000)
              .map((key) => ({ Key: key })),
          },
        }),
      );
      if (response.Errors?.length)
        throw new Error(
          `Deleting ${response.Errors[0].Key} failed: ${response.Errors[0].Code}`,
        );
    }
    console.log(
      `[move-runtime-to-private-bucket] ${deletable.length} of ${source.size} object(s) deleted from ${from}`,
    );
    return;
  }

  let copied = 0;
  for (const object of source.values()) {
    const copy = copies.get(object.key);
    if (copy && copy.modified >= object.modified) continue;
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: to,
        // The copy source is a URL path, so each segment is encoded.
        CopySource: `${from}/${object.key.split("/").map(encodeURIComponent).join("/")}`,
        Key: object.key,
      }),
    );
    copied += 1;
  }
  console.log(
    `[move-runtime-to-private-bucket] ${copied} of ${source.size} object(s) copied to ${to}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[move-runtime-to-private-bucket] fatal:", error);
    process.exit(1);
  });
