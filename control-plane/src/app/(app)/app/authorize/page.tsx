import { validateRequest } from "@/lib/auth";
import { authorizeInput } from "@/lib/app-api/tokens";
import AppConsent from "./AppConsent";
import AppSignIn from "./AppSignIn";
import { APP_PANEL } from "../panel";

const CLIENT_NAMES = { ios: "iPhone·iPad", macos: "Mac", android: "Android" };

// Where the Naru app sends its sign-in (lib/app-api/tokens.ts): the person
// signs in to naru.pub right here, without the site's /login page and its
// links, then connects the app.
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
      <div className={APP_PANEL}>
        <h1 className="text-xl font-bold">앱을 연결할 수 없습니다</h1>
        <p role="alert">
          로그인 요청이 올바르지 않습니다. 앱에서 다시 로그인해 주세요.
        </p>
      </div>
    );
  }
  const { user } = await validateRequest();
  if (!user) return <AppSignIn />;
  return (
    <AppConsent
      input={input}
      account={user.loginName}
      device={CLIENT_NAMES[input.client]}
    />
  );
}
