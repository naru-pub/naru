import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { validateRequest } from "@/lib/auth";
import DeleteAccountButton from "../DeleteAccountButton";

export const metadata: Metadata = { title: "계정 삭제 · 나루" };

// The account page's own deletion, on a page of its own, after sign-in.
// Releases of the Naru app before /app/account/delete open it from 계정 삭제.
export default async function DeleteAccountPage() {
  const { user } = await validateRequest();
  if (!user) redirect(`/login?next=${encodeURIComponent("/account/delete")}`);
  return (
    <div className="max-w-xl mx-auto p-6 space-y-5">
      <h1 className="text-2xl font-bold">계정 삭제</h1>
      <p>
        <strong>{user.loginName}</strong> 계정과 홈페이지, 파일, 사이트
        데이터베이스가 모두 지워지며 되돌릴 수 없습니다. 이메일을 인증한
        계정은 확인 메일의 링크를 눌러야 삭제가 끝납니다.
      </p>
      <DeleteAccountButton />
    </div>
  );
}
