import type { Metadata } from "next";
import { validateRequest } from "@/lib/auth";
import DeleteAccountButton from "../../../../(main)/account/DeleteAccountButton";
import AppSignIn from "../../authorize/AppSignIn";
import SwitchAccount from "../../SwitchAccount";
import { APP_PANEL } from "../../panel";

export const metadata: Metadata = { title: "계정 삭제 · 나루" };

// Where the Naru app's 계정 삭제 opens (App Store guideline 5.1.1(v)): the
// account page's own deletion, signed in on this page rather than /login.
export default async function AppDeleteAccountPage() {
  const { user } = await validateRequest();
  if (!user) return <AppSignIn />;
  return (
    <div className={APP_PANEL}>
      <h1 className="text-2xl font-bold">계정 삭제</h1>
      <p>
        <strong>{user.loginName}</strong> 계정과 홈페이지, 파일, 사이트
        데이터베이스가 모두 지워지며 되돌릴 수 없습니다. 이메일을 인증한 계정은
        확인 메일의 링크를 눌러야 삭제가 끝납니다.
      </p>
      <DeleteAccountButton app />
      <SwitchAccount account={user.loginName} />
    </div>
  );
}
