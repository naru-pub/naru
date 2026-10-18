// The Naru app's association with naru.pub (Apple fetches it through its CDN
// when the app is installed; served as JSON, without a redirect). Team
// K4CQ85R27U, bundle pub.naru: one target for iOS and macOS.
//
// - webcredentials: lets ASWebAuthenticationSession return to the app through
//   an HTTPS callback on naru.pub, which only this app can receive, and offers
//   naru.pub's saved passwords in the app.
// - applinks: only /app/callback opens the app, so no other naru.pub page,
//   the sign-in pages included, is ever taken over by it.
const APP_ID = "K4CQ85R27U.pub.naru";

export const dynamic = "force-static";

export function GET() {
  return Response.json(
    {
      applinks: {
        details: [
          {
            appIDs: [APP_ID],
            components: [
              { "/": "/app/callback", comment: "Sign-in returns to the app" },
            ],
          },
        ],
      },
      webcredentials: { apps: [APP_ID] },
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
