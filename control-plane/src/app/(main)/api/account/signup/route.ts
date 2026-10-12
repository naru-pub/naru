import { NextRequest, NextResponse } from "next/server";
import { purgeSiteObjects } from "@/lib/cache-purge";
import { createSession, setSessionCookie } from "@/lib/auth";
import { db } from "@/lib/database";
import { hash } from "@node-rs/argon2";
import {
  DEFAULT_INDEX_HTML,
  isReservedLoginName,
  LOGIN_NAME_REGEX,
} from "@/lib/const";
import { PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { s3Client } from "@/lib/s3";
import { assertJsonContentType } from "@/lib/utils";
import { getUserHomeDirectory } from "@/lib/site-urls";

async function prepareUserHomeDirectory(userName: string) {
  const bucketName = process.env.S3_BUCKET_NAME!;

  // Check if index.html exists
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucketName,
        Key: `${getUserHomeDirectory(userName)}/index.html`.replaceAll(
          "//",
          "/",
        ),
      }),
    );
  } catch (error: any) {
    // If file doesn't exist (404), create it
    if (error.$metadata?.httpStatusCode === 404) {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: `${getUserHomeDirectory(userName)}/index.html`.replaceAll(
            "//",
            "/",
          ),
          Body: DEFAULT_INDEX_HTML,
          ContentType: "text/html",
        }),
      );
      // A visit before the name was taken left the edge keeping its absence.
      await purgeSiteObjects([`${getUserHomeDirectory(userName)}/index.html`]);
    } else {
      throw error;
    }
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

    const { login_name, password } = await request.json();

    if (!login_name || !password) {
      return NextResponse.json(
        { success: false, message: "아이디와 비밀번호를 입력해주세요." },
        { status: 400 },
      );
    }

    if (
      typeof login_name !== "string" ||
      !LOGIN_NAME_REGEX.test(login_name) ||
      isReservedLoginName(login_name)
    ) {
      return NextResponse.json(
        { success: false, message: "사용할 수 없는 아이디입니다." },
        { status: 400 },
      );
    }

    const normalizedLoginName = login_name.toLowerCase();
    const password_hash = await hash(password);

    await prepareUserHomeDirectory(normalizedLoginName);

    let user;
    try {
      user = await db
        .insertInto("users")
        .values({
          login_name: normalizedLoginName,
          password_hash,
          home_directory_size_bytes: 0,
          home_directory_size_bytes_updated_at: null,
        })
        .returningAll()
        .execute();
    } catch (e: any) {
      if (e.message.includes("users_login_name_key")) {
        return NextResponse.json(
          { success: false, message: "이미 사용 중인 아이디입니다." },
          { status: 400 },
        );
      }
      throw e;
    }

    const session = await createSession(user[0].id);
    await setSessionCookie(session);

    return NextResponse.json({
      success: true,
      message: "가입이 완료되었습니다.",
    });
  } catch (error) {
    console.error("Signup error:", error);
    return NextResponse.json(
      { success: false, message: "가입 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
