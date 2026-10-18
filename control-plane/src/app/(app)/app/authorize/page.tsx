import { validateRequest } from "@/lib/auth";
import AppConsent from "./AppConsent";
import AppSignIn from "./AppSignIn";
import { APP_PANEL } from "../panel";
import { appSignInRequest } from "./request";

const CLIENT_NAMES = { ios: "iPhone·iPad", macos: "Mac", android: "Android" };

// Where the Naru app sends its sign-in (lib/app-api/tokens.ts): the person
// signs in to naru.pub right here, without the site's /login page and its
// links, or signs up on /app/signup, which comes back here; then connects the
// app. The app's 나루 계정 만들기 opens /app/signup with the same request.
export default async function AppAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { query, input } = await appSignInRequest(searchParams);
  if (!input)
    return (
      <div className={APP_PANEL}>
        <h1 className="text-xl font-bold">앱을 연결할 수 없습니다</h1>
        <p role="alert">
          로그인 요청이 올바르지 않습니다. 앱에서 다시 로그인해 주세요.
        </p>
      </div>
    );
  const { user } = await validateRequest();
  if (!user) return <AppSignIn signUpHref={`/app/signup?${query}`} />;
  return (
    <AppConsent
      input={input}
      account={user.loginName}
      device={CLIENT_NAMES[input.client]}
    />
  );
}
