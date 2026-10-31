import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

// Template versions' files, _templates/<id>/v<n>/…, now live in the private
// bucket (lib/site-code-bucket). This moves the ones written before into it.
// The shared client already reads and writes them there, so run it right
// after the deploy that brings the change, before templates are applied
// again. Safe to run again: a
// key already moved is no longer in the site bucket to list.
//
//   node dist/cli/move-template-files-private.mjs [--dry-run]
const TEMPLATE_FILE = /^_templates\/[^/]+\/v\d+\//;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const site = process.env.S3_BUCKET_NAME!;
  const privateBucket = process.env.S3_PRIVATE_BUCKET_NAME!;
  if (!site || !privateBucket)
    throw new Error("S3_BUCKET_NAME and S3_PRIVATE_BUCKET_NAME must be set");
  // Not lib/s3's client: its routing would hide the keys still to move.
  const client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ACCOUNT_ID
      ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });

  let moved = 0;
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: site,
        Prefix: "_templates/",
        ContinuationToken: token,
      }),
    );
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    const keys = (page.Contents ?? [])
      .map((object) => object.Key!)
      .filter((key) => TEMPLATE_FILE.test(key));
    if (dryRun) {
      moved += keys.length;
      continue;
    }
    for (const key of keys) {
      await client.send(
        new CopyObjectCommand({
          Bucket: privateBucket,
          CopySource: `${site}/${key.split("/").map(encodeURIComponent).join("/")}`,
          Key: key,
        }),
      );
    }
    if (keys.length) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: site,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
    moved += keys.length;
  } while (token);
  console.log(
    `[move-template-files-private] ${moved} object(s) ${dryRun ? "to move" : "moved"}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[move-template-files-private] fatal:", error);
    process.exit(1);
  });
