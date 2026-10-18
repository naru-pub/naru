// The Naru Android app's association with naru.pub (Digital Asset Links;
// Android fetches it when the app is installed, served as JSON, without a
// redirect). Package pub.naru, by the certificates that sign it: Play App
// Signing's key, which signs what Play installs, and the upload key, which
// signs builds installed from app-release.aab directly.
//
// - handle_all_urls: verifies the app's App Links. Android has no paths here;
//   the app's manifest claims only https://naru.pub/app/callback, so no other
//   naru.pub page is ever taken over by it.
// - get_login_creds: offers naru.pub's saved passwords and passkeys in the app.
const FINGERPRINTS = [
  // Play App Signing
  "83:AF:41:B7:AF:18:9C:54:B2:9F:5F:69:8D:5A:76:27:6F:7F:70:69:68:73:A8:B1:27:21:5E:F3:63:88:D3:C6",
  // Upload key
  "35:C4:51:56:59:EB:B9:B6:08:30:0F:51:44:29:95:74:4A:2F:3C:1A:23:01:A5:C6:24:C5:0F:2E:DC:2D:72:49",
];

export const dynamic = "force-static";

export function GET() {
  return Response.json(
    [
      {
        relation: [
          "delegate_permission/common.handle_all_urls",
          "delegate_permission/common.get_login_creds",
        ],
        target: {
          namespace: "android_app",
          package_name: "pub.naru",
          sha256_cert_fingerprints: FINGERPRINTS,
        },
      },
    ],
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
