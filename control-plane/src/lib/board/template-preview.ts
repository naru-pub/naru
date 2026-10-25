// A template's own preview image: what its post and the board show in place
// of the screenshots of its versions, for templates whose files alone can't
// show what they look like (an app that needs its site's data, or a
// sign-in). Its author uploads it from the post's forms, or its workflow
// publishes it beside a version (template-uploads.ts). Apart from
// templates.ts, whose errors need Next, so the CLI bundle can use it.
import { createHash } from "node:crypto";
import { db } from "@/lib/database";
import { BoardError } from "./board-error";
import {
  formatBytes,
  TEMPLATE_PREVIEW_MAX_BYTES,
  TEMPLATE_PREVIEW_TYPES,
} from "./constants";
import { templateCustomPreviewKey } from "./preview";
import * as storage from "./storage";

export type PreviewType = (typeof TEMPLATE_PREVIEW_TYPES)[number];

// The type the bytes are, by their signature rather than what the uploader
// says, so the bucket never serves anything else under an image's type.
export function sniffPreviewType(bytes: Uint8Array): PreviewType | null {
  const starts = (signature: number[], at = 0) =>
    signature.every((byte, index) => bytes[at + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  // RIFF....WEBP
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  return null;
}

export function assertPreviewSize(size: number) {
  if (!Number.isInteger(size) || size <= 0) {
    throw new BoardError(400, "미리보기 이미지가 비어 있어요.");
  }
  if (size > TEMPLATE_PREVIEW_MAX_BYTES) {
    throw new BoardError(
      400,
      `미리보기 이미지는 ${formatBytes(TEMPLATE_PREVIEW_MAX_BYTES)}까지 올릴 수 있어요.`,
    );
  }
}

/** Sets `bytes` as the template's preview, replacing any before it. */
export async function storeTemplatePreview(
  templateId: string,
  bytes: Uint8Array,
): Promise<void> {
  assertPreviewSize(bytes.byteLength);
  const contentType = sniffPreviewType(bytes);
  if (!contentType) {
    throw new BoardError(
      400,
      "미리보기 이미지는 PNG, JPEG, WebP 파일만 올릴 수 있어요.",
    );
  }
  await storage.putObject(
    templateCustomPreviewKey(templateId),
    bytes,
    contentType,
  );
  await db
    .updateTable("board_templates")
    .set({
      preview_content_type: contentType,
      preview_sha256: createHash("sha256").update(bytes).digest("hex"),
      preview_updated_at: new Date(),
    })
    .where("id", "=", templateId)
    .execute();
}

/** Back to the screenshots of the template's versions. */
export async function clearTemplatePreview(templateId: string): Promise<void> {
  await db
    .updateTable("board_templates")
    .set({
      preview_content_type: null,
      preview_sha256: null,
      preview_updated_at: null,
    })
    .where("id", "=", templateId)
    .execute();
  await storage.deleteObjects([templateCustomPreviewKey(templateId)]);
}
