import Link from "next/link";
import { validateRequest } from "@/lib/auth";
import {
  memberSignInInput,
  previewMemberSignIn,
} from "@/lib/site-data/member-auth";
import { DataError } from "@/lib/site-data/validation";
import MemberConsent from "./MemberConsent";

// Where a site's naru.members.signIn() sends its visitor: any Naru account can
// sign in to the site as a member, after saying so here.
export default async function MemberSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Only the recognized scalar fields. Never redirect to a supplied URL on error.
  const query = new URLSearchParams();
  for (const key of ["site", "redirectUri", "challenge", "state"])
    if (typeof params[key] === "string") query.set(key, params[key]);
  let input;
  try {
    input = memberSignInInput(Object.fromEntries(query));
  } catch {
    return <Problem message="로그인 요청이 올바르지 않습니다." />;
  }
  const { user } = await validateRequest();
  if (!user) {
    const next = encodeURIComponent(`/members/sign-in?${query}`);
    return (
      <div className="max-w-xl mx-auto p-6 space-y-5">
        <h1 className="text-2xl font-bold">{input.site} 회원으로 로그인</h1>
        <p>
          <strong>{input.site}</strong> 사이트에 회원으로 로그인하려면 나루
          계정이 필요합니다.
        </p>
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
  let preview;
  try {
    preview = await previewMemberSignIn(user.id, input);
  } catch (error) {
    return (
      <Problem
        message={
          error instanceof DataError
            ? error.message
            : "요청을 확인하지 못했습니다. 다시 시도해 주세요."
        }
      />
    );
  }
  if (!preview.mayJoin)
    return (
      <div className="max-w-xl mx-auto p-6 space-y-5">
        <h1 className="text-2xl font-bold">{input.site} 회원으로 로그인</h1>
        <p>
          나루 사이트의 회원이 되려면 나루 후원 플랜이 필요합니다. 후원을 시작한
          뒤 사이트에서 다시 로그인해 주세요.
        </p>
        <Link href="/supporter" className="underline">
          나루 후원하기
        </Link>
      </div>
    );
  if (preview.needsVerifiedEmail)
    return (
      <div className="max-w-xl mx-auto p-6 space-y-5">
        <h1 className="text-2xl font-bold">{input.site} 회원으로 로그인</h1>
        <p>
          이 사이트는 이메일을 인증한 나루 계정만 회원으로 받습니다. 계정
          설정에서 이메일을 인증한 뒤 사이트에서 다시 로그인해 주세요. 사이트는
          이메일 주소를 받지 않습니다.
        </p>
        <Link href="/account" className="underline">
          이메일 인증하러 가기
        </Link>
      </div>
    );
  return (
    <MemberConsent
      input={input}
      account={user.loginName}
      notifications={preview.notifications}
    />
  );
}

function Problem({ message }: { message: string }) {
  return (
    <div className="max-w-xl mx-auto p-6">
      <h1 className="text-xl font-bold">회원 로그인을 진행할 수 없습니다</h1>
      <p role="alert">{message}</p>
    </div>
  );
}
