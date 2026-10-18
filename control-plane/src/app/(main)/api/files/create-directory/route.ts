import { NextRequest, NextResponse } from "next/server";
import { purgeSiteObjects } from "@/lib/cache-purge";
import {
  PutObjectCommand,
  HeadObjectCommand,
  NotFound,
} from "@aws-sdk/client-s3";
import { validateRequest } from "@/lib/auth";
import { refuseSuspendedSite } from "@/lib/site-suspension";
import { s3Client } from "@/lib/s3";
import { assertJsonContentType } from "@/lib/utils";
import { getUserObjectKey } from "@/lib/site-urls";
import { assertNoPathTraversal } from "@/lib/file-paths";
import { revalidatePath } from "next/cache";
import { User } from "@/lib/auth";
import { DEFAULT_INDEX_HTML, FILE_EXTENSION_MIMETYPE_MAP } from "@/lib/const";
import { recordSiteEdit } from "@/lib/database";

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
    const suspended = await refuseSuspendedSite(user.id);
    if (suspended) return suspended;

    const { directory } = await request.json();

    if (!directory) {
      return NextResponse.json(
        { success: false, message: "디렉토리명이 필요합니다." },
        { status: 400 },
      );
    }

    try {
      assertNoPathTraversal(directory);
    } catch (e: any) {
      return NextResponse.json(
        { success: false, message: e.message },
        { status: 400 },
      );
    }

    const key = getUserObjectKey(user.loginName, `${directory}/index.html`);

    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          Key: key,
        }),
      );
    } catch (e) {
      if (e instanceof NotFound) {
        try {
          await s3Client.send(
            new PutObjectCommand({
              Bucket: process.env.S3_BUCKET_NAME!,
              Key: key,
              Body: DEFAULT_INDEX_HTML,
              ContentType: FILE_EXTENSION_MIMETYPE_MAP["html"],
            }),
          );
        } catch (e) {
          console.error("S3 create directory error:", e);
          return NextResponse.json(
            { success: false, message: "파일 생성에 실패했습니다." },
            { status: 500 },
          );
        }
      }
    }

    // The edge may have kept the index's absence.
    await purgeSiteObjects([key]);
    revalidatePath("/files", "layout");
    await recordSiteEdit(user.id);

    return NextResponse.json({
      success: true,
      message: "폴더가 생성되었습니다.",
    });
  } catch (error) {
    console.error("Create directory error:", error);
    return NextResponse.json(
      { success: false, message: "디렉토리 생성에 실패했습니다." },
      { status: 500 },
    );
  }
}
