import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { isSiteCode } from "@/lib/site-code-bucket";

// Each site's code, `<login>/_naru/` (and a suspended site's,
// `_suspended/<login>/_naru/`), used to live in the site bucket, where
// r2.naru.pub served it to anyone. It now lives in the private bucket, under
// the same keys (site-code-bucket.ts). This copies it across: an object the
// private bucket lacks, or has an older copy of, so a run after the release
// that writes the private bucket keeps what that release wrote. Safe to run
// again.
//
// With --delete, it instead deletes from the site bucket each object the
// private bucket holds a copy of, as large and no older; anything else is
// reported and left.
//
//   node dist/cli/move-site-code-to-private-bucket.mjs [--delete]

// Not the shared client (s3.ts), which would send all of this to the
// private bucket.
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

type Listed = { key: string; size: number; modified: number };

async function list(bucket: string, prefix: string, delimiter?: string) {
  const objects = new Map<string, Listed>();
  const prefixes: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: delimiter,
        ContinuationToken: cursor,
      }),
    );
    for (const object of page.Contents ?? [])
      objects.set(object.Key!, {
        key: object.Key!,
        size: object.Size ?? 0,
        modified: object.LastModified?.getTime() ?? 0,
      });
    for (const { Prefix } of page.CommonPrefixes ?? []) prefixes.push(Prefix!);
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (cursor);
  return { objects, prefixes };
}

/** Every `_naru/` object in `bucket`, a site at a time. */
async function siteCode(bucket: string) {
  const homes = [
    ...(await list(bucket, "", "/")).prefixes,
    ...(await list(bucket, "_suspended/", "/")).prefixes,
  ];
  const objects = new Map<string, Listed>();
  for (const home of homes)
    for (const [key, object] of (await list(bucket, `${home}_naru/`)).objects)
      if (isSiteCode(key)) objects.set(key, object);
  return objects;
}

async function main() {
  const from = process.env.S3_BUCKET_NAME;
  const to = process.env.S3_PRIVATE_BUCKET_NAME;
  if (!from || !to)
    throw new Error("S3_BUCKET_NAME and S3_PRIVATE_BUCKET_NAME must be set");
  const remove = process.argv.includes("--delete");
  const [source, copies] = await Promise.all([siteCode(from), siteCode(to)]);

  if (remove) {
    const deletable: string[] = [];
    for (const object of source.values()) {
      const copy = copies.get(object.key);
      if (copy && copy.size === object.size && copy.modified >= object.modified)
        deletable.push(object.key);
      else
        console.log(
          `[move-site-code-to-private-bucket] keeping ${object.key}: no copy as new`,
        );
    }
    for (let offset = 0; offset < deletable.length; offset += 1000) {
      const response = await s3.send(
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
      `[move-site-code-to-private-bucket] ${deletable.length} of ${source.size} object(s) deleted from ${from}`,
    );
    return;
  }

  let copied = 0;
  for (const object of source.values()) {
    const copy = copies.get(object.key);
    if (copy && copy.modified >= object.modified) continue;
    try {
      await s3.send(
        new CopyObjectCommand({
          Bucket: to,
          // The copy source is a URL path, so each segment is encoded.
          CopySource: `${from}/${object.key.split("/").map(encodeURIComponent).join("/")}`,
          Key: object.key,
        }),
      );
    } catch (error: any) {
      // Deleted since it was listed.
      if (error?.name !== "NoSuchKey") throw error;
      console.log(`[move-site-code-to-private-bucket] ${object.key} is gone`);
      continue;
    }
    copied += 1;
  }
  console.log(
    `[move-site-code-to-private-bucket] ${copied} of ${source.size} object(s) copied to ${to}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[move-site-code-to-private-bucket] fatal:", error);
    process.exit(1);
  });
