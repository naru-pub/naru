import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { validateRequest } from "@/lib/auth";
import { s3Client } from "@/lib/s3";
import { getUserHomeDirectory, getUserObjectKey } from "@/lib/site-urls";
import { EDITABLE_FILE_EXTENSIONS } from "@/lib/const";

export async function GET(request: NextRequest) {
  let user = null;
  let userDir = "";
  let filePath = "";

  try {
    const authResult = await validateRequest();
    user = authResult.user;

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Log environment info for production debugging (safe logging)
    if (process.env.NODE_ENV === "production") {
      console.log("Production file content request:", {
        hasS3Bucket: !!process.env.S3_BUCKET_NAME,
        hasAwsKeys:
          !!process.env.AWS_ACCESS_KEY_ID &&
          !!process.env.AWS_SECRET_ACCESS_KEY,
        hasR2AccountId: !!process.env.R2_ACCOUNT_ID,
        userExists: !!user?.loginName,
        nodeEnv: process.env.NODE_ENV,
      });
    }

    const url = new URL(request.url);
    filePath = url.searchParams.get("path") || "";

    if (!filePath) {
      return NextResponse.json(
        { error: "File path is required" },
        { status: 400 },
      );
    }

    // Security check: prevent path traversal attacks
    if (filePath.includes("..") || filePath.startsWith("/")) {
      return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
    }

    // Security check: ensure the file is editable
    const extension = filePath.split(".").pop()?.toLowerCase() || "";

    if (!EDITABLE_FILE_EXTENSIONS.includes(extension)) {
      return NextResponse.json(
        { error: `File type '${extension}' not editable` },
        { status: 400 },
      );
    }

    // Use proper path construction for S3 keys (always use forward slashes)
    userDir = getUserHomeDirectory(user.loginName);
    const s3Key = getUserObjectKey(user.loginName, filePath);

    // CRITICAL SECURITY CHECK: Ensure the S3 key stays within user's directory
    if (!s3Key.startsWith(`${userDir}/`) || s3Key === userDir) {
      console.error("SECURITY VIOLATION: Attempted path traversal", {
        user: user.loginName,
        userDir,
        filePath,
        constructedKey: s3Key,
      });
      return NextResponse.json(
        { error: "Access denied: Invalid file path" },
        { status: 403 },
      );
    }

    // Log the exact S3 key being requested (production safe)
    console.log("Requesting S3 key:", s3Key);

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: s3Key,
    });

    const response = await s3Client.send(command);
    const content = (await response.Body?.transformToString()) || "";

    // The editor sends the ETag back when it saves, so a save over a newer
    // version (from MCP, the apps, another tab) is refused, not lost.
    return new NextResponse(content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        ...(response.ETag ? { ETag: response.ETag } : {}),
      },
    });
  } catch (error) {
    console.error("Error fetching file content:", error);
    console.error("Error details:", {
      name: error instanceof Error ? error.name : "Unknown",
      message: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Log production-safe debugging info for NoSuchKey errors
    if (error instanceof Error && error.name === "NoSuchKey" && user) {
      console.error("NoSuchKey error - file not found in S3");

      // List available files for this user to help debug
      try {
        const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
        const debugUserDir = userDir || getUserHomeDirectory(user.loginName);
        const listCommand = new ListObjectsV2Command({
          Bucket: process.env.S3_BUCKET_NAME!,
          Prefix: `${debugUserDir}/`, // Add trailing slash to ensure exact directory match
          MaxKeys: 20,
        });
        const listResponse = await s3Client.send(listCommand);
        const availableKeys =
          listResponse.Contents?.map((obj) => obj.Key) || [];
        console.log("Available S3 keys for user (first 20):", availableKeys);
        console.log("Requested path was:", filePath);
      } catch (listError) {
        console.error("Could not list S3 objects for debugging:", listError);
      }
    }

    return NextResponse.json(
      { error: "Failed to fetch file content" },
      { status: 500 },
    );
  }
}
