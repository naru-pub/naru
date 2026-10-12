import { NextRequest, NextResponse } from "next/server";
import { purgeSiteObjects } from "@/lib/cache-purge";
import {
  PutObjectCommand,
  HeadObjectCommand,
  NotFound,
} from "@aws-sdk/client-s3";
import { validateRequest } from "@/lib/auth";
import { s3Client } from "@/lib/s3";
import { assertJsonContentType } from "@/lib/utils";
import { getUserObjectKey } from "@/lib/site-urls";
import { assertNoPathTraversal } from "@/lib/file-paths";
import { revalidatePath } from "next/cache";
import { User } from "@/lib/auth";
import * as Sentry from "@sentry/nextjs";
import {
  EDITABLE_FILE_EXTENSIONS,
  FILE_EXTENSION_MIMETYPE_MAP,
} from "@/lib/const";
import { recordSiteEdit } from "@/lib/database";

function assertEditableFilename(filename: string) {
  const extension = filename.split(".").pop();
  if (!extension || !EDITABLE_FILE_EXTENSIONS.includes(extension)) {
    throw new Error(`File type ${extension} is not editable.`);
  }
}

export async function POST(request: NextRequest) {
  try {
    try {
      assertJsonContentType(request);
    } catch {
      return NextResponse.json(
        { success: false, message: "Invalid content type" },
        { status: 400 },
      );
    }

    const { user } = await validateRequest();
    if (!user) {
      return NextResponse.json(
        { success: false, message: "로그인이 필요합니다." },
        { status: 401 },
      );
    }

    const { directory, filename } = await request.json();

    if (directory === null || directory === undefined || !filename) {
      return NextResponse.json(
        { success: false, message: "디렉토리와 파일명이 필요합니다." },
        { status: 400 },
      );
    }

    try {
      if (directory) {
        assertNoPathTraversal(directory);
      }
      assertNoPathTraversal(filename);
      assertEditableFilename(filename);
    } catch (e: any) {
      return NextResponse.json(
        { success: false, message: e.message },
        { status: 400 },
      );
    }

    const normalizedKey = getUserObjectKey(
      user.loginName,
      `${directory}/${filename}`,
    );

    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          Key: normalizedKey,
        }),
      );

      return NextResponse.json(
        { success: false, message: "이미 존재하는 파일입니다." },
        { status: 400 },
      );
    } catch (e) {
      if (e instanceof NotFound) {
        try {
          await s3Client.send(
            new PutObjectCommand({
              Bucket: process.env.S3_BUCKET_NAME!,
              Key: normalizedKey,
              Body: "", // Create empty file
              ContentType:
                FILE_EXTENSION_MIMETYPE_MAP[filename.split(".").pop()!],
            }),
          );

          // The edge may have kept the file's absence.
          await purgeSiteObjects([normalizedKey]);
          revalidatePath("/files", "layout");
          await recordSiteEdit(user.id);

          return NextResponse.json({
            success: true,
            message: "파일이 생성되었습니다.",
          });
        } catch (e) {
          Sentry.captureException(e);
          console.error("S3 create file error:", e);
          return NextResponse.json(
            { success: false, message: "파일 생성에 실패했습니다." },
            { status: 500 },
          );
        }
      }

      Sentry.captureException(e);
      console.error("Create file error:", e);
      return NextResponse.json(
        { success: false, message: "파일 생성에 실패했습니다." },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error("Create file error:", error);
    return NextResponse.json(
      { success: false, message: "파일 생성에 실패했습니다." },
      { status: 500 },
    );
  }
}
