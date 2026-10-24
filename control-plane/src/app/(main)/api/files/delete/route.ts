import { NextRequest, NextResponse } from "next/server";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { validateRequest } from "@/lib/auth";
import { refuseSuspendedSite } from "@/lib/site-suspension";
import { s3Client } from "@/lib/s3";
import { assertJsonContentType } from "@/lib/utils";
import { getUserObjectKey } from "@/lib/site-urls";
import { assertNoPathTraversal } from "@/lib/file-paths";
import * as Sentry from "@sentry/nextjs";
import { purgeSiteObjects } from "@/lib/cache-purge";
import { recordSiteEdit } from "@/lib/database";
import { revalidatePath } from "next/cache";

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

    const { filename } = await request.json();

    if (!filename) {
      return NextResponse.json(
        { success: false, message: "파일명이 필요합니다." },
        { status: 400 },
      );
    }

    try {
      assertNoPathTraversal(filename);
    } catch (e: any) {
      return NextResponse.json(
        { success: false, message: e.message },
        { status: 400 },
      );
    }

    // A folder comes with or without its trailing slash.
    const path = filename.replace(/\/+$/, "");

    if (path === "index.html") {
      return NextResponse.json(
        { success: false, message: "홈 페이지는 삭제할 수 없습니다." },
        { status: 400 },
      );
    }

    const key = getUserObjectKey(user.loginName, path);

    try {
      // The file at the path, or the files in the folder at it: "blog" is
      // blog and blog/…, never blogroll.html beside it.
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3Client.send(
          new ListObjectsV2Command({
            Bucket: process.env.S3_BUCKET_NAME!,
            Prefix: key,
            ContinuationToken: token,
          }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key === key || object.Key?.startsWith(`${key}/`))
            keys.push(object.Key);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);

      // DeleteObjects takes at most 1000 keys.
      for (let i = 0; i < keys.length; i += 1000) {
        await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Delete: {
              Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
            },
          }),
        );
      }

      await purgeSiteObjects(keys);
    } catch (e) {
      Sentry.captureException(e);
      console.error("S3 delete error:", e);
      return NextResponse.json(
        { success: false, message: "파일 삭제에 실패했습니다." },
        { status: 500 },
      );
    }

    revalidatePath("/files", "layout");
    await recordSiteEdit(user.id);

    return NextResponse.json({
      success: true,
      message: "파일이 삭제되었습니다.",
    });
  } catch (error) {
    console.error("Delete error:", error);
    return NextResponse.json(
      { success: false, message: "파일 삭제에 실패했습니다." },
      { status: 500 },
    );
  }
}
