import { deleteMedia } from "./media-deletion";
import { MEDIA_TYPES } from "./media-types";
import { uuidv7 } from "@/lib/uuid";
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sql } from "kysely";
import { db, requestDeadline } from "@/lib/database";
import { s3Client } from "@/lib/s3";
import { resolveSiteAccess } from "./service";
import { callSiteObject } from "@/lib/edge/client";
import { DataError, uuidId } from "./validation";
import { decodeCursor, encodeCursor, sorting } from "./pagination";

export const MAX_MEDIA_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_SITE_BYTES = 250 * 1024 * 1024;
// The byte quota alone does not bound row count: the minimum file is one byte,
// so a quota's worth of tiny files is millions of rows. Listing is paged, but
// the count still has to stop somewhere the cleanup job and the owner's own
// library screen can cope with.
export const MAX_MEDIA_FILES = 10000;
// Members upload into the site's quota, which one of them could otherwise
// fill for everyone; the owner's own uploads are not limited.
export const MEMBER_UPLOADS_PER_HOUR = 30;
const mediaBucket = () => process.env.SITE_DATA_MEDIA_BUCKET || "naru-media";
const mediaOrigin = () =>
  (process.env.SITE_DATA_MEDIA_ORIGIN || "https://media.naru.pub").replace(
    /\/$/,
    "",
  );
const allowedTypes = new Set<string>(MEDIA_TYPES);

/** The external object-store boundary, kept narrow so API contracts can run locally. */
export const mediaStorage = {
  // The type and length are signed: the URL takes only the declared file,
  // so it cannot store more than the quota counted or serve, say, HTML.
  authorizeUpload(objectKey: string, contentType: string, size: number) {
    return getSignedUrl(
      // Smithy package versions differ between the S3 client and presigner.
      s3Client as never,
      new PutObjectCommand({
        Bucket: mediaBucket(),
        Key: objectKey,
        ContentType: contentType,
        ContentLength: size,
      }) as never,
      {
        expiresIn: 10 * 60,
        signableHeaders: new Set(["content-type", "content-length"]),
      },
    );
  },
  headObject(objectKey: string) {
    return s3Client.send(
      new HeadObjectCommand({ Bucket: mediaBucket(), Key: objectKey }),
    );
  },
};

type MediaCommand = {
  site: string;
  path: string[];
  method: string;
  adminUserId?: string;
  // An owner's or a member's token. Mutable: tokenScope and memberScope
  // report the expiry the renewed token now has.
  bearer?: { token: string; origin: string | null; expiresAt?: number };
  body?: Record<string, unknown>;
  after?: string;
  size?: number;
  usage?: boolean;
  /** The owner's library asks where the site's tables name its uploads. */
  tableReferences?: boolean;
  filter?: unknown;
};
/** What the site's object answers of where its tables name uploads. */
type TableReferences = {
  references: Record<string, { table: string; column: string }[]>;
  partial: boolean;
};
/** The object stops searching at 8 s (TABLE_SCAN_MS, edge/src/site.ts). */
const TABLE_REFERENCES_TIMEOUT_MS = 20_000;
/** Newest first is what a media library is for, and the only order offered. */
const MEDIA_SORT = sorting("createdAt", "desc");

function publicUrl(objectKey: string) {
  return `${mediaOrigin()}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}
function output(file: {
  id: string;
  object_key: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  created_at: Date | string;
  updated_at: Date | string;
}) {
  return {
    id: file.id,
    name: file.original_name,
    contentType: file.content_type,
    size: file.size_bytes,
    url: publicUrl(file.object_key),
    createdAt: file.created_at,
    updatedAt: file.updated_at,
  };
}
function uploadInput(body: Record<string, unknown>) {
  const filename = typeof body.name === "string" ? body.name.trim() : "";
  const contentType =
    typeof body.contentType === "string" ? body.contentType.toLowerCase() : "";
  const size = body.size;
  if (!filename || filename.length > 255 || /[\u0000-\u001f]/.test(filename))
    throw new DataError(
      400,
      "File name must contain 1–255 printable characters.",
    );
  if (!allowedTypes.has(contentType))
    throw new DataError(
      415,
      `${contentType ? `Naru does not store ${contentType} files` : "The file has no type"}. It stores ${[...allowedTypes].join(", ")}.`,
    );
  if (
    !Number.isInteger(size) ||
    Number(size) < 1 ||
    Number(size) > MAX_MEDIA_FILE_BYTES
  )
    throw new DataError(413, "File must be between 1 byte and 25 MiB.");
  return { filename, contentType, size: Number(size) };
}

/**
 * Tells the site's object of finished uploads, for ctx.media.get: one as it
 * is ready, or (`all`) every one, as the owner opens the library. Its
 * record helps site code check an upload, so a failure here does not fail
 * the upload; the next library visit records it again.
 */
async function recordUploads(
  site: string,
  files: {
    id: string;
    object_key: string;
    member_id: string | null;
    original_name: string;
    content_type: string;
    size_bytes: number;
    created_at: Date | string;
  }[],
  all = false,
) {
  try {
    for (let at = 0; at < files.length; at += 1000)
      await callSiteObject(site, "recordMedia", {
        files: files.slice(at, at + 1000).map((file) => ({
          id: file.id,
          url: publicUrl(file.object_key),
          member: file.member_id,
          name: file.original_name,
          type: file.content_type,
          size: file.size_bytes,
          createdAt: new Date(file.created_at).getTime(),
        })),
      });
    // Last, so a record of an upload Naru deleted does not stay.
    if (all)
      await callSiteObject(site, "recordMedia", {
        files: [],
        keep: files.map((file) => file.id),
      });
  } catch (error) {
    console.warn("Recording uploads in the site's object failed", error);
  }
}

export async function executeMedia(command: MediaCommand) {
  if (command.path.length > 1) throw new DataError(404, "Not found.");
  const { owner, allowedIds, memberId } = await resolveSiteAccess({
    ...command,
    ownerMediaDelete: command.method === "DELETE",
  });
  const admin = command.adminUserId === owner.id || allowedIds !== undefined;
  if (!admin && memberId === undefined)
    throw new DataError(403, "Uploading needs an owner or member sign-in.");
  if (command.adminUserId !== undefined && command.adminUserId !== owner.id)
    throw new DataError(403, "Permission denied.");
  // Listing remains the control panel's. Deletion needs an explicit owner
  // grant or the authenticated member's own upload.
  const uploading =
    (command.method === "POST" && command.path.length === 0) ||
    (command.method === "PUT" && command.path.length === 1);
  if (
    command.bearer !== undefined &&
    !uploading &&
    !(command.method === "DELETE" && command.path.length === 1)
  )
    throw new DataError(403, "Website tokens can only upload files.");
  const files = () =>
    db.selectFrom("site_data_files").where("user_id", "=", owner.id);
  const readUsage = async () => {
    const usage = await files()
      .select([
        sql<number>`coalesce(sum(size_bytes) filter (where delete_completed_at is null or delete_completed_at < coalesce(upload_expires_at, created_at + interval '1 hour')), 0)`.as(
          "bytes",
        ),
        sql<number>`count(*)`.as("count"),
        sql<number>`count(*) filter (where status = 'pending' and deleted_at is null)`.as(
          "pending",
        ),
      ])
      .executeTakeFirstOrThrow();
    return {
      bytes: Number(usage.bytes),
      count: Number(usage.count),
      pending: Number(usage.pending),
      maxBytes: MAX_MEDIA_SITE_BYTES,
    };
  };
  if (command.method === "GET" && command.path.length === 0) {
    // A quota readout is a single aggregate row, and only the control panel's
    // own library screen shows one; website tokens are not offered it.
    if (command.usage && command.adminUserId !== undefined)
      return { usage: await readUsage() };
    // Where the site's own tables (1.1.0) name its uploads, which no write
    // records: searched now, as the owner opens the library, once for every
    // upload rather than for each page (`tableMediaReferences`,
    // edge/src/site.ts). `partial` when the search stopped short.
    if (command.tableReferences && command.adminUserId !== undefined) {
      const ready = await files()
        .where("status", "=", "ready")
        .where("deleted_at", "is", null)
        .select([
          "id",
          "object_key",
          "member_id",
          "original_name",
          "content_type",
          "size_bytes",
          "created_at",
        ])
        .orderBy("created_at", "desc")
        .limit(MAX_MEDIA_FILES)
        .execute();
      // Every upload, as ctx.media.get reads them: missed or stale records
      // are put right as the owner looks.
      await recordUploads(command.site, ready, true);
      const ids = ready.map((file) => file.id);
      if (!ids.length) return { tableReferences: {}, partial: false };
      const found = await callSiteObject<TableReferences>(
        command.site,
        "tableMediaReferences",
        { ids },
        undefined,
        TABLE_REFERENCES_TIMEOUT_MS,
      );
      return {
        tableReferences: Object.fromEntries(
          ids.flatMap((id) => {
            const places = found.references[id.toLowerCase()];
            return places?.length ? [[id, places]] : [];
          }),
        ),
        partial: found.partial,
      };
    }
    // Refused rather than ignored: a caller that still filters by what a file
    // belongs to would otherwise get the whole library back, and delete it.
    if (command.filter !== undefined)
      throw new DataError(400, "Files cannot be filtered.");
    const limit = command.size ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DataError(400, "Page size must be 1–100.");
    // Files are not queried by what they belong to: a page records the URLs
    // it uses, and the library is only ever read newest first.
    const cursor = decodeCursor(
      command.after,
      owner.id,
      MEDIA_SORT,
      undefined,
      "f",
    );
    // Unfinished uploads too: their address may already be in use, so
    // they stay until the owner deletes them, and the library marks them.
    let query = files()
      .where("status", "in", ["ready", "pending"])
      .where("deleted_at", "is", null)
      .selectAll()
      .select(
        sql<string>`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          "cursor_value",
        ),
      )
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1);
    if (cursor) uuidId(cursor.id);
    if (cursor)
      query = query.where(
        sql<boolean>`(created_at, id) < (${cursor.value}::timestamptz, ${cursor.id})`,
      );
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    // An upload no document names is marked, not deleted: the owner
    // decides (the control panel's media library shows it, with what
    // `tableReferences` finds in the site's tables).
    const ready = page
      .filter((file) => file.status === "ready")
      .map((file) => file.id);
    const used = new Set(
      ready.length
        ? await callSiteObject<string[]>(command.site, "mediaReferences", {
            ids: ready,
          })
        : [],
    );
    return {
      files: page.map((file) => ({
        ...output(file),
        ...(file.status === "ready" ? { referenced: used.has(file.id) } : {}),
        ...(file.status === "pending"
          ? {
              unfinished: true,
              uploadExpiresAt:
                file.upload_expires_at ??
                new Date(new Date(file.created_at).getTime() + 60 * 60 * 1000),
            }
          : {}),
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(
              owner.id,
              MEDIA_SORT,
              last.id,
              last.cursor_value,
              undefined,
              "f",
            )
          : null,
    };
  }
  const id = command.path[0] ? uuidId(command.path[0]) : undefined;
  if (command.method === "POST" && command.path.length === 0) {
    const input = uploadInput(command.body || {});
    const fileId = uuidv7();
    const extension = input.filename.includes(".")
      ? input.filename
          .split(".")
          .pop()!
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 10)
      : "";
    const objectKey = `${owner.id}/${fileId}${extension ? `.${extension}` : ""}`;
    const file = await db.transaction().execute(async (tx) => {
      await requestDeadline(tx);
      await tx
        .selectFrom("users")
        .select("id")
        .where("id", "=", owner.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const usage = await tx
        .selectFrom("site_data_files")
        .where("user_id", "=", owner.id)
        .select([
          sql<number>`coalesce(sum(size_bytes) filter (where delete_completed_at is null or delete_completed_at < coalesce(upload_expires_at, created_at + interval '1 hour')), 0)`.as(
            "bytes",
          ),
          sql<number>`count(*)`.as("count"),
        ])
        .executeTakeFirstOrThrow();
      if (Number(usage.bytes) + input.size > MAX_MEDIA_SITE_BYTES)
        throw new DataError(
          409,
          "Media storage quota exceeded.",
          "QUOTA_EXCEEDED",
        );
      // Counted as well as measured: the byte quota does not bound rows, and an
      // authorization loop would otherwise mint them without limit.
      if (Number(usage.count) >= MAX_MEDIA_FILES)
        throw new DataError(
          409,
          "Media file count limit reached.",
          "QUOTA_EXCEEDED",
        );
      if (memberId !== undefined) {
        const recent = await tx
          .selectFrom("site_data_files")
          .where("member_id", "=", memberId)
          .where("created_at", ">", new Date(Date.now() - 60 * 60 * 1000))
          .select(sql<number>`count(*)`.as("count"))
          .executeTakeFirstOrThrow();
        if (Number(recent.count) >= MEMBER_UPLOADS_PER_HOUR)
          throw new DataError(
            429,
            `A member can upload ${MEMBER_UPLOADS_PER_HOUR} files an hour. Try again later.`,
          );
      }
      return tx
        .insertInto("site_data_files")
        .values({
          id: fileId,
          user_id: owner.id,
          object_key: objectKey,
          original_name: input.filename,
          content_type: input.contentType,
          size_bytes: input.size,
          member_id: memberId ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    try {
      const uploadUrl = await mediaStorage.authorizeUpload(
        objectKey,
        input.contentType,
        input.size,
      );
      // Record after signing, with a clock-skew margin. Do not free the
      // reservation while a signed URL could recreate deleted bytes.
      const active = await db
        .updateTable("site_data_files")
        .where("id", "=", fileId)
        .where("deleted_at", "is", null)
        .set({ upload_expires_at: new Date(Date.now() + 11 * 60 * 1000) })
        .returning("id")
        .executeTakeFirst();
      if (!active) throw new DataError(409, "Upload was canceled.");
      // PUT the bytes to uploadUrl with these headers, then finalize by id.
      return {
        id: file.id,
        uploadUrl,
        headers: { "Content-Type": input.contentType },
      };
    } catch (error) {
      await db
        .deleteFrom("site_data_files")
        .where("id", "=", fileId)
        .where("deleted_at", "is", null)
        .execute();
      throw error;
    }
  }
  if (command.method === "PUT" && id) {
    const file = await files()
      .where("deleted_at", "is", null)
      .where("id", "=", id)
      .selectAll()
      .executeTakeFirst();
    // A member finishes only their own upload.
    if (!file || (memberId !== undefined && file.member_id !== memberId))
      throw new DataError(404, "File not found.");
    let head;
    try {
      head = await mediaStorage.headObject(file.object_key);
    } catch {
      throw new DataError(409, "Upload has not completed.");
    }
    if (
      head.ContentLength !== file.size_bytes ||
      head.ContentType !== file.content_type
    ) {
      await deleteMedia(owner.id, id);
      throw new DataError(
        409,
        "Uploaded file does not match its authorization.",
      );
    }
    const ready = await db
      .updateTable("site_data_files")
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .set({ status: "ready", updated_at: new Date() })
      .returningAll()
      .executeTakeFirst();
    if (!ready) throw new DataError(404, "File not found.");
    await recordUploads(command.site, [ready]);
    return { file: output(ready) };
  }
  if (command.method === "DELETE" && id) {
    await deleteMedia(owner.id, id, memberId);
    try {
      await callSiteObject(command.site, "forgetMedia", { ids: [id] });
    } catch (error) {
      // The next library visit drops it from the object's record.
      console.warn("Forgetting an upload in the site's object failed", error);
    }
    return { success: true };
  }
  throw new DataError(405, "Method not allowed.");
}

// Media live under <user id>/.
export async function deleteUserMedia(userId: string) {
  await deletePrefix(`${userId}/`);
}

async function deletePrefix(prefix: string) {
  let continuationToken: string | undefined;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: mediaBucket(),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    if (page.Contents?.length) {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: mediaBucket(),
          Delete: {
            Objects: page.Contents.map((object) => ({ Key: object.Key! })),
          },
        }),
      );
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
}
