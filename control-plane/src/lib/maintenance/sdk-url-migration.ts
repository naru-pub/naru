import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { purgeSiteFiles, purgeUrls } from "@/lib/cache-purge";
import { listObjects } from "@/lib/board/storage";
import { templateFileKey } from "@/lib/board/preview";
import { encodedObjectPath } from "@/lib/edge/file-cache";
import { s3Client } from "@/lib/s3";
import { getSiteBucketUrl, getUserHomeDirectory } from "@/lib/site-urls";
import {
  MAX_REWRITE_BYTES,
  isTextFile,
  looksBinary,
  rewriteSdkUrlBytes,
} from "@/lib/sdk-urls";

// Rewrites the Data SDK's old URL (lib/sdk-urls.ts) in every stored file a
// site is made of, for cli/rewrite-sdk-urls.ts:
//
// - each site's files, `<login>/...` in the site bucket, `.backup/` copies
//   included. `<login>/_naru/` is site code: the edge runs it, and changing
//   it publishes a new function release (cache-purge.ts), so matches there
//   are reported, not rewritten.
// - template snapshots, `_templates/<id>/v<n>/...`, which applying a template
//   copies into a site (board/templates.ts).
//
// Not the other prefixes: `_naru-runtime/` holds releases named by the hash
// of their sources, built from `<login>/_naru/`; `__deploy_uploads/` holds a
// deploy's staged files, checked against its manifest's digests when it
// publishes; `_screenshots/` and the media bucket hold images.
//
// A changed file is written back only if it is still the one read (If-Match
// on its ETag), with its content type, cache headers and metadata, a sha256
// in the metadata (deploys record one) recomputed. Then, as after an edit,
// the edge's and r2.naru.pub's copies are purged, and the site's recorded
// size moves by the bytes added. Not site_updated_at: that would announce
// every such site as updated to its followers and on the home page.

export interface StoredFile {
  body: Uint8Array;
  etag: string;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  metadata?: Record<string, string>;
}

export interface SdkUrlBucket {
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  get(key: string): Promise<StoredFile | null>;
  /** Writes `body` if the object's ETag is still `file.etag`; false if not. */
  put(key: string, body: Buffer, file: StoredFile): Promise<boolean>;
}

const bucketName = () => process.env.S3_BUCKET_NAME!;

export const s3SdkUrlBucket: SdkUrlBucket = {
  list: (prefix) => listObjects(prefix),
  async get(key) {
    try {
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: bucketName(), Key: key }),
      );
      return {
        body: await object.Body!.transformToByteArray(),
        etag: object.ETag!,
        contentType: object.ContentType,
        cacheControl: object.CacheControl,
        contentDisposition: object.ContentDisposition,
        contentEncoding: object.ContentEncoding,
        contentLanguage: object.ContentLanguage,
        metadata: object.Metadata,
      };
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  },
  async put(key, body, file) {
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: key,
          Body: body,
          IfMatch: file.etag,
          ContentType: file.contentType,
          CacheControl: file.cacheControl,
          ContentDisposition: file.contentDisposition,
          ContentEncoding: file.contentEncoding,
          ContentLanguage: file.contentLanguage,
          Metadata: file.metadata,
        }),
      );
      return true;
    } catch (error: any) {
      const status = error?.$metadata?.httpStatusCode;
      // 412: changed since it was read. 404: deleted since.
      if (status === 412 || status === 404) return false;
      throw error;
    }
  },
};

export interface SdkUrlDeps {
  bucket: SdkUrlBucket;
  purgeSiteFiles: (login: string, paths: string[]) => Promise<unknown>;
  purgeUrls: (urls: string[]) => Promise<void>;
}

const defaultDeps: SdkUrlDeps = {
  bucket: s3SdkUrlBucket,
  purgeSiteFiles,
  purgeUrls,
};

export interface FileResult {
  key: string;
  count: number;
  snippets: string[];
  /** rewritten: written (or would be, in a dry run); reported: site code. */
  outcome: "rewritten" | "would-rewrite" | "reported" | "changed";
}

export interface SdkUrlReport {
  files: FileResult[];
  /** Matches by site, or by `_templates/<id>` for a template. */
  bySite: Map<string, { files: number; matches: number }>;
  scanned: number;
  skipped: number;
  failed: string[];
}

export interface SdkUrlOptions {
  apply: boolean;
  site?: string;
  concurrency?: number;
  log?: (line: string) => void;
}

async function eachLimit<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await run(items[next++]);
    }),
  );
}

/** The metadata to write back: a recorded sha256 made true again. */
function rewrittenMetadata(file: StoredFile, body: Buffer) {
  if (!file.metadata?.sha256) return file.metadata;
  return {
    ...file.metadata,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

export async function rewriteStoredSdkUrls(
  options: SdkUrlOptions,
  deps: SdkUrlDeps = defaultDeps,
): Promise<SdkUrlReport> {
  const log = options.log ?? console.log;
  const concurrency = options.concurrency ?? 8;
  const report: SdkUrlReport = {
    files: [],
    bySite: new Map(),
    scanned: 0,
    skipped: 0,
    failed: [],
  };

  // One file: read, rewrite, and write back if asked. Returns the bytes added
  // when it was written.
  async function visit(
    key: string,
    group: string,
    { contentType, siteCode }: { contentType?: string; siteCode: boolean },
  ): Promise<number | null> {
    let file: StoredFile | null;
    try {
      file = await deps.bucket.get(key);
    } catch (error) {
      report.failed.push(key);
      log(`[rewrite-sdk-urls] ${key}: read failed: ${error}`);
      return null;
    }
    if (!file) return null;
    report.scanned += 1;
    if (
      !isTextFile(key, file.contentType ?? contentType) ||
      looksBinary(file.body) ||
      // Compressed bodies would need decompressing; sites do not store any.
      (file.contentEncoding && file.contentEncoding !== "identity")
    ) {
      report.skipped += 1;
      return null;
    }
    const { body, count, snippets } = rewriteSdkUrlBytes(file.body);
    if (!body) return null;

    const totals = report.bySite.get(group) ?? { files: 0, matches: 0 };
    totals.files += 1;
    totals.matches += count;
    report.bySite.set(group, totals);

    let outcome: FileResult["outcome"];
    if (siteCode) outcome = "reported";
    else if (!options.apply) outcome = "would-rewrite";
    else {
      try {
        outcome = (await deps.bucket.put(key, body, {
          ...file,
          metadata: rewrittenMetadata(file, body),
        }))
          ? "rewritten"
          : "changed";
      } catch (error) {
        report.failed.push(key);
        log(`[rewrite-sdk-urls] ${key}: write failed: ${error}`);
        return null;
      }
    }
    report.files.push({ key, count, snippets, outcome });
    const label = {
      rewritten: "rewrote",
      "would-rewrite": "would rewrite",
      reported: "site code, not rewritten",
      changed: "changed since read, skipped",
    }[outcome];
    log(`[rewrite-sdk-urls] ${key}: ${count} match(es), ${label}`);
    if (outcome !== "rewritten")
      for (const snippet of snippets) log(`    ${snippet}`);
    return outcome === "rewritten"
      ? body.byteLength - file.body.byteLength
      : null;
  }

  // Sites.
  let users = db.selectFrom("users").select(["id", "login_name"]);
  if (options.site) users = users.where("login_name", "=", options.site);
  for (const user of await users.orderBy("login_name").execute()) {
    const home = `${getUserHomeDirectory(user.login_name)}/`;
    const objects = (await deps.bucket.list(home)).filter((object) => {
      // Extension-less names may still be text by content type: read them.
      const name = object.key.slice(object.key.lastIndexOf("/") + 1);
      const candidate = isTextFile(object.key) || !name.includes(".");
      if (!candidate || object.size > MAX_REWRITE_BYTES) {
        report.skipped += 1;
        return false;
      }
      return true;
    });
    const written: string[] = [];
    let added = 0;
    await eachLimit(objects, concurrency, async ({ key }) => {
      const path = key.slice(home.length);
      const delta = await visit(key, user.login_name, {
        siteCode: path.startsWith("_naru/"),
      });
      if (delta !== null) {
        written.push(path);
        added += delta;
      }
    });
    if (written.length === 0) continue;
    await deps.purgeSiteFiles(user.login_name, written);
    await db
      .updateTable("users")
      .set({
        home_directory_size_bytes: sql`home_directory_size_bytes + ${added}`,
      })
      .where("id", "=", user.id)
      .where("home_directory_size_bytes", "is not", null)
      .execute();
  }

  // Template snapshots.
  let templateFiles = db
    .selectFrom("board_template_files as f")
    .innerJoin("board_template_versions as v", "v.id", "f.version_id")
    .innerJoin("board_templates as t", "t.id", "v.template_id")
    .select([
      "f.version_id",
      "f.path",
      "f.content_type",
      "f.size_bytes",
      "v.template_id",
      "v.version",
    ]);
  if (options.site)
    templateFiles = templateFiles
      .innerJoin("users as u", "u.id", "t.user_id")
      .where("u.login_name", "=", options.site);
  const rows = (
    await templateFiles.orderBy("v.template_id").orderBy("v.version").execute()
  ).filter((row) => {
    const candidate =
      isTextFile(row.path, row.content_type) &&
      Number(row.size_bytes) <= MAX_REWRITE_BYTES;
    if (!candidate) report.skipped += 1;
    return candidate;
  });
  const purged: string[] = [];
  await eachLimit(rows, concurrency, async (row) => {
    const key = templateFileKey(row.template_id, row.version, row.path);
    const delta = await visit(key, `_templates/${row.template_id}`, {
      contentType: row.content_type,
      siteCode: false,
    });
    if (delta === null) return;
    purged.push(getSiteBucketUrl(encodedObjectPath(key)));
    await db.transaction().execute(async (tx) => {
      await tx
        .updateTable("board_template_files")
        .set({ size_bytes: sql`size_bytes + ${delta}` })
        .where("version_id", "=", row.version_id)
        .where("path", "=", row.path)
        .execute();
      await tx
        .updateTable("board_template_versions")
        .set({ size_bytes: sql`size_bytes + ${delta}` })
        .where("id", "=", row.version_id)
        .execute();
    });
  });
  if (purged.length) await deps.purgeUrls(purged);

  return report;
}
