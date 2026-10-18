// Where the Apple app's sign-in returns (lib/app-api/tokens.ts). The app's
// ASWebAuthenticationSession takes this address before it loads, so a page
// only shows when it is opened some other way, such as a browser that was
// not the app's.
export default function AppCallbackPage() {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">나루 앱 로그인</h1>
      <p>
        이 페이지는 나루 앱의 로그인 화면에서 열립니다. 나루 앱으로 돌아가 다시
        로그인해 주세요.
      </p>
    </div>
  );
}
