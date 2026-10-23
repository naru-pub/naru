import { NextRequest, NextResponse } from "next/server";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { validateRequest } from "@/lib/auth";
import { refuseSuspendedSite } from "@/lib/site-suspension";
import { s3Client } from "@/lib/s3";
import { assertJsonContentType } from "@/lib/utils";
import { getUserObjectKey } from "@/lib/site-urls";
import { assertNoPathTraversal, assertPlainFilename } from "@/lib/file-paths";
import { revalidatePath } from "next/cache";
import { purgeSiteFiles } from "@/lib/cache-purge";
import { recordSiteEdit } from "@/lib/database";
import { ALLOWED_FILE_EXTENSIONS } from "@/lib/const";

// The paths of every file under a folder, relative to the home directory.
async function listFolder(loginName: string, folder: string) {
  const home = getUserObjectKey(loginName, "");
  const paths: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET_NAME!,
        Prefix: getUserObjectKey(loginName, `${folder}/`),
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key && !object.Key.endsWith("/"))
        paths.push(object.Key.slice(home.length));
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return paths;
}

function validateFilename(filename: string) {
  // Length validation
  if (filename.length > 255) {
    throw new Error("파일명이 너무 깁니다. (최대 255자)");
  }

  if (filename.length === 0) {
    throw new Error("파일명이 비어있습니다.");
  }

  // Reserved names on Windows
  const reservedNames = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
  ];
  const nameWithoutExt = filename.split(".")[0].toUpperCase();
  if (reservedNames.includes(nameWithoutExt)) {
    throw new Error("예약된 파일명입니다.");
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
    const suspended = await refuseSuspendedSite(user.id);
    if (suspended) return suspended;

    const body = await request.json();
    // isDirectory renames a folder: every file under it moves to the new name.
    const { oldFilename, newFilename, isDirectory } = body;

    if (!oldFilename || !newFilename) {
      return NextResponse.json(
        { success: false, message: "기존 파일명과 새 파일명이 필요합니다." },
        { status: 400 },
      );
    }

    let newPath: string;
    try {
      assertNoPathTraversal(oldFilename);
      // Renaming stays within the file's directory; /api/files/move moves.
      assertPlainFilename(newFilename);
      validateFilename(newFilename);
      if (!isDirectory) {
        const extension = newFilename.includes(".")
          ? newFilename.split(".").pop()!.toLowerCase()
          : "";
        if (!ALLOWED_FILE_EXTENSIONS.includes(extension)) {
          throw new Error(
            `.${extension || "(확장자 없음)"} 파일은 호스팅할 수 없습니다.`,
          );
        }
      }

      // Calculate new full path
      const pathParts = oldFilename.split("/");
      pathParts[pathParts.length - 1] = newFilename;
      newPath = pathParts.join("/");
      assertNoPathTraversal(newPath);
    } catch (e: any) {
      return NextResponse.json(
        { success: false, message: e.message },
        { status: 400 },
      );
    }

    if (oldFilename === "index.html") {
      return NextResponse.json(
        { success: false, message: "홈 페이지 이름은 변경할 수 없습니다." },
        { status: 400 },
      );
    }

    // Copying an object onto itself and then deleting the source would lose it.
    if (
      getUserObjectKey(user.loginName, oldFilename) ===
      getUserObjectKey(user.loginName, newPath)
    ) {
      return NextResponse.json({
        success: true,
        message: "파일 이름이 변경되었습니다.",
        newPath,
      });
    }

    try {
      // [from, to] for each file the rename moves.
      let moves: [string, string][];
      if (isDirectory) {
        const from = await listFolder(user.loginName, oldFilename);
        if (from.length === 0) {
          return NextResponse.json(
            { success: false, message: "폴더를 찾을 수 없습니다." },
            { status: 404 },
          );
        }
        if ((await listFolder(user.loginName, newPath)).length > 0) {
          return NextResponse.json(
            {
              success: false,
              message: `"${newFilename}" 폴더가 이미 존재합니다.`,
            },
            { status: 409 },
          );
        }
        moves = from.map((path) => [
          path,
          newPath + path.slice(oldFilename.length),
        ]);
      } else {
        moves = [[oldFilename, newPath]];
      }

      for (const [from, to] of moves) {
        await s3Client.send(
          new CopyObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            CopySource: `${process.env.S3_BUCKET_NAME}/${encodeURIComponent(
              getUserObjectKey(user.loginName, from),
            ).replace(/%2F/g, "/")}`,
            Key: getUserObjectKey(user.loginName, to),
          }),
        );
      }
      for (const [from] of moves) {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: getUserObjectKey(user.loginName, from),
          }),
        );
      }

      await purgeSiteFiles(user.loginName, moves.flat());

      revalidatePath("/files", "layout");
      await recordSiteEdit(user.id);

      return NextResponse.json({
        success: true,
        message: isDirectory
          ? "폴더 이름이 변경되었습니다."
          : "파일 이름이 변경되었습니다.",
        newPath,
      });
    } catch (error) {
      console.error("S3 rename error:", error);
      return NextResponse.json(
        { success: false, message: "파일 이름 변경에 실패했습니다." },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error("Rename error:", error);
    return NextResponse.json(
      { success: false, message: "파일 이름 변경에 실패했습니다." },
      { status: 500 },
    );
  }
}
