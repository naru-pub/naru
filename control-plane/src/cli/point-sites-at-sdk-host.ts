import { parseArgs } from "node:util";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { purgeSiteObjects } from "@/lib/cache-purge";
import { db } from "@/lib/database";
import { pointBytesAtSdkHost, SDK_REFERENCE_FILE } from "@/lib/deploy/sdk-host";
import { s3Client } from "@/lib/s3";

// Points sites' files at the SDK's own host (lib/deploy/sdk-host.ts): each
// page, script or import map under <login>/ that loads naru.pub/sdk/ is
// written back with SDK_ORIGIN instead, its content type and metadata kept,
// and its cached copies purged. A file someone saves meanwhile is left for the
// next run (the write is conditional on what was read).
//
//   node dist/cli/point-sites-at-sdk-host.mjs --site <login> [--site …] [--dry-run]

const MAX_BYTES = 10 * 1024 * 1024;
const bucket = () => process.env.S3_BUCKET_NAME!;

async function pointSite(login: string, dryRun: boolean) {
  const changed: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: `${login}/`,
        ContinuationToken: cursor,
      }),
    );
    for (const object of page.Contents ?? []) {
      const key = object.Key!;
      // Site functions run on Naru, not in a page.
      if (key.startsWith(`${login}/_naru/`)) continue;
      if (!SDK_REFERENCE_FILE.test(key) || (object.Size ?? 0) > MAX_BYTES)
        continue;
      const found = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket(), Key: key }),
      );
      const rewritten = pointBytesAtSdkHost(
        (await found.Body!.transformToByteArray()) ?? new Uint8Array(),
      );
      if (!rewritten) continue;
      changed.push(key);
      if (dryRun) continue;
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key: key,
          Body: rewritten,
          IfMatch: found.ETag,
          ContentType: found.ContentType,
          CacheControl: found.CacheControl,
          ContentDisposition: found.ContentDisposition,
          ContentLanguage: found.ContentLanguage,
          Metadata: found.Metadata,
        }),
      );
    }
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (cursor);
  if (changed.length && !dryRun) await purgeSiteObjects(changed);
  return changed;
}

async function main() {
  const { values } = parseArgs({
    options: {
      site: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!process.env.SDK_ORIGIN)
    throw new Error("Set SDK_ORIGIN, such as https://sdk.naru.pub.");
  if (!values.site?.length) throw new Error("Name the sites with --site.");
  const failed: string[] = [];
  let files = 0;
  for (const login of values.site) {
    try {
      const changed = await pointSite(login, values["dry-run"]!);
      files += changed.length;
      for (const key of changed)
        console.log(
          `[point-sites-at-sdk-host] ${values["dry-run"] ? "would point" : "pointed"} ${key}`,
        );
    } catch (error) {
      failed.push(login);
      console.error(`[point-sites-at-sdk-host] ${login} failed:`, error);
    }
  }
  console.log(
    `[point-sites-at-sdk-host] ${files} files in ${values.site.length} sites` +
      (failed.length ? `, failed: ${failed.join(", ")}` : ""),
  );
  if (failed.length) process.exitCode = 1;
}

main().finally(() => db.destroy());
