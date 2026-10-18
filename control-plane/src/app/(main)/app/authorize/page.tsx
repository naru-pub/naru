import type { Metadata } from "next";
import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import { authorizeInput } from "@/lib/app-api/tokens";
import AppConsent from "./AppConsent";

export const metadata: Metadata = { title: "나루 앱 연결 · 나루" };

const CLIENT_NAMES = { ios: "iPhone·iPad", macos: "Mac", android: "Android" };

// Where the Naru app sends its sign-in (lib/app-api/tokens.ts): the person
// signs in to naru.pub as they would anywhere, then connects the app here.
export default async function AppAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Only the recognized scalar fields; never redirect anywhere else on error.
  const query = new URLSearchParams();
  for (const key of [
    "client",
    "redirect_uri",
    "state",
    "code_challenge",
    "code_challenge_method",
  ])
    if (typeof params[key] === "string") query.set(key, params[key]);
  let input;
  try {
    input = authorizeInput(Object.fromEntries(query));
  } catch {
    return (
      <div className="max-w-xl mx-auto p-6 space-y-3">
        <h1 className="text-xl font-bold">앱을 연결할 수 없습니다</h1>
        <p role="alert">
          로그인 요청이 올바르지 않습니다. 앱에서 다시 로그인해 주세요.
        </p>
      </div>
    );
  }
  const { user } = await validateRequest();
  if (!user) {
    const next = encodeURIComponent(`/app/authorize?${query}`);
    return (
      <div className="max-w-xl mx-auto p-6 space-y-5">
        <h1 className="text-2xl font-bold">나루 앱 로그인</h1>
        <p>나루 계정으로 로그인하면 앱으로 돌아갑니다.</p>
        <div className="flex gap-3">
          <Link href={`/login?next=${next}`} className="underline">
            나루 계정으로 로그인
          </Link>
          <Link href={`/signup?next=${next}`} className="underline">
            나루 계정 만들기
          </Link>
        </div>
      </div>
    );
  }
  return (
    <AppConsent
      input={input}
      account={user.loginName}
      device={CLIENT_NAMES[input.client]}
    />
  );
}
