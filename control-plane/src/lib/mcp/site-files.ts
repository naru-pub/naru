import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import * as Sentry from "@sentry/nextjs";
import { revalidatePath } from "next/cache";
import { purgeSiteFiles } from "@/lib/cache-purge";
import {
  ALLOWED_FILE_EXTENSIONS,
  EDITABLE_FILE_EXTENSIONS,
  FILE_EXTENSION_MIMETYPE_MAP,
  IMAGE_FILE_EXTENSIONS,
} from "@/lib/const";
import { db, recordSiteEdit } from "@/lib/database";
import { assertNoPathTraversal } from "@/lib/file-paths";
import { extractHtmlTitle } from "@/lib/html";
import { s3Client } from "@/lib/s3";
import { siteSuspended, SUSPENDED_MESSAGE } from "@/lib/site-suspension";
import {
  collapseSlashes,
  getPublicAssetUrl,
  getUserHomeDirectory,
  getUserObjectKey,
} from "@/lib/site-urls";

// A site's files as Naru MCP's tools reach them: the same keys, limits and
// follow-up work as the file manager's routes (app/(main)/api/files), for
// one site, the account the connection belongs to. Errors a tool's caller
// should read are FileError; anything else is Naru's own failure.

export class FileError extends Error {}

export interface Site {
  userId: string;
  loginName: string;
}

/** The same cap as the file manager's uploads and saves. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** What read_file returns inline: a larger file is described instead. */
export const MAX_READ_BYTES = 1024 * 1024;
const MAX_LISTED = 2000;

const extensionOf = (path: string) =>
  path.includes(".") ? path.split(".").pop()!.toLowerCase() : "";

export const isText = (path: string) =>
  EDITABLE_FILE_EXTENSIONS.includes(extensionOf(path));
export const isImage = (path: string) =>
  IMAGE_FILE_EXTENSIONS.includes(extensionOf(path));
export const contentTypeOf = (path: string) =>
  FILE_EXTENSION_MIMETYPE_MAP[extensionOf(path)] ?? "application/octet-stream";

/** A file's path from a tool's argument: relative to the site's root. */
export function filePath(value: string): string {
  const path = collapseSlashes(value.trim()).replace(/^\/+/, "");
  try {
    assertNoPathTraversal(path);
  } catch (error) {
    throw new FileError((error as Error).message);
  }
  if (!path || path.endsWith("/"))
    throw new FileError(
      "Give a file's path, such as index.html or css/site.css.",
    );
  return path;
}

/** A folder's path from a tool's argument: "" for the whole site, else "a/b/". */
export function folderPath(value: string | undefined): string {
  const path = collapseSlashes((value ?? "").trim())
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  try {
    assertNoPathTraversal(path);
  } catch (error) {
    throw new FileError((error as Error).message);
  }
  return path ? `${path}/` : "";
}

/** The public address of a file; _naru/ is private site code, with none. */
export const fileUrl = (site: Site, path: string) =>
  path === "_naru" || path.startsWith("_naru/")
    ? null
    : getPublicAssetUrl(site.loginName, path);

async function head(site: Site, path: string) {
  try {
    return await s3Client.send(
      new HeadObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: getUserObjectKey(site.loginName, path),
      }),
    );
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey") return null;
    throw error;
  }
}

async function assertWritable(site: Site) {
  if (await siteSuspended(site.userId)) throw new FileError(SUSPENDED_MESSAGE);
}

/** The site's files under a folder, in key order, at most MAX_LISTED. */
export async function listFiles(site: Site, folder: string) {
  const home = `${getUserHomeDirectory(site.loginName)}/`;
  const files: { path: string; size: number; modified: string | null }[] = [];
  let token: string | undefined;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET_NAME!,
        Prefix: `${home}${folder}`,
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (!object.Key || object.Key.endsWith("/")) continue;
      files.push({
        path: object.Key.slice(home.length),
        size: object.Size ?? 0,
        modified: object.LastModified?.toISOString() ?? null,
      });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token && files.length < MAX_LISTED);
  return {
    files: files.slice(0, MAX_LISTED),
    truncated: files.length > MAX_LISTED || !!token,
  };
}

export type ReadResult =
  | { kind: "text"; text: string; size: number }
  | { kind: "image"; data: string; mimeType: string; size: number }
  | { kind: "other"; size: number; contentType: string };

export async function readFile(site: Site, path: string): Promise<ReadResult> {
  const info = await head(site, path);
  if (!info) throw new FileError(`${path} does not exist.`);
  const size = info.ContentLength ?? 0;
  const contentType = info.ContentType ?? contentTypeOf(path);
  const readable = isText(path) || isImage(path);
  if (!readable || size > MAX_READ_BYTES)
    return { kind: "other", size, contentType };
  const object = await s3Client.send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: getUserObjectKey(site.loginName, path),
    }),
  );
  const bytes = Buffer.from((await object.Body?.transformToByteArray()) ?? []);
  return isText(path)
    ? { kind: "text", text: bytes.toString("utf8"), size }
    : {
        kind: "image",
        data: bytes.toString("base64"),
        mimeType: contentType,
        size,
      };
}

// What every change does after the files are in place: the edit stats, the
// site's title when its home page changes, and the cache purge, which also
// installs _naru/ declarations and site code (cache-purge.ts).
async function afterChange(site: Site, paths: string[]) {
  try {
    await recordSiteEdit(site.userId);
  } catch (error) {
    Sentry.captureException(error);
  }
  revalidatePath("/files", "layout");
  try {
    await purgeSiteFiles(site.loginName, paths);
  } catch (error) {
    Sentry.captureException(error);
    throw new FileError(
      "The file is saved, but updating the site did not finish. Check its _naru/ files and save again; queued updates retry on their own.",
    );
  }
}

export async function writeFile(site: Site, path: string, body: Buffer) {
  const extension = extensionOf(path);
  if (!ALLOWED_FILE_EXTENSIONS.includes(extension))
    throw new FileError(
      `Naru does not host .${extension || "(no extension)"} files. Allowed: ${ALLOWED_FILE_EXTENSIONS.join(", ")}.`,
    );
  if (path.split("/").pop()!.length > 255)
    throw new FileError("The file name is over 255 characters.");
  if (body.length > MAX_FILE_BYTES)
    throw new FileError("Files are limited to 10 MB.");
  await assertWritable(site);
  const existed = !!(await head(site, path));
  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: getUserObjectKey(site.loginName, path),
      Body: body,
      ContentType: contentTypeOf(path),
    }),
  );
  if (path === "index.html" || path === "index.htm") {
    try {
      await db
        .updateTable("users")
        .set({ site_title: extractHtmlTitle(body.toString("utf8")) })
        .where("id", "=", site.userId)
        .execute();
    } catch (error) {
      Sentry.captureException(error);
    }
  }
  await afterChange(site, [path]);
  return { created: !existed, size: body.length };
}

export async function deleteFile(site: Site, path: string) {
  if (path === "index.html")
    throw new FileError("The home page, index.html, can't be deleted.");
  await assertWritable(site);
  if (!(await head(site, path))) throw new FileError(`${path} does not exist.`);
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: getUserObjectKey(site.loginName, path),
    }),
  );
  await afterChange(site, [path]);
}

export async function moveFile(site: Site, from: string, to: string) {
  if (from === to) throw new FileError("The file is already at that path.");
  if (from === "index.html")
    throw new FileError("The home page, index.html, can't be moved.");
  if (!ALLOWED_FILE_EXTENSIONS.includes(extensionOf(to)))
    throw new FileError(`Naru does not host .${extensionOf(to)} files.`);
  await assertWritable(site);
  if (!(await head(site, from))) throw new FileError(`${from} does not exist.`);
  if (await head(site, to))
    throw new FileError(`${to} already exists. Delete it first to replace it.`);
  await s3Client.send(
    new CopyObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      CopySource: `${process.env.S3_BUCKET_NAME}/${encodeURIComponent(
        getUserObjectKey(site.loginName, from),
      ).replace(/%2F/g, "/")}`,
      Key: getUserObjectKey(site.loginName, to),
    }),
  );
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: getUserObjectKey(site.loginName, from),
    }),
  );
  await afterChange(site, [from, to]);
}
