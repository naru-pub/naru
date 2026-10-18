# Naru app and site push notifications

One Naru app for iOS, macOS and Android delivers notifications that sites send
to their members. Sites never handle device tokens or push credentials: a
mutation calls `ctx.notify(memberIds, message)`, Naru resolves each member to
the Naru account behind it, and delivers to that account's devices if the
account has allowed the site.

Clients: [naru-pub/apple](https://github.com/naru-pub/apple) (SwiftUI, iOS +
macOS) and [naru-pub/android](https://github.com/naru-pub/android)
(Compose). Both are thin native apps with four tabs:

- **둘러보기** — the showcase of naru.pub's front page and `/sites`: screenshots
  of discoverable sites, newest update first. It needs no account, so the app
  is useful (and reviewable) before anyone signs in.
- **알림** — the inbox, or the sign-in prompt when signed out.
- **사이트** — the per-site allow/mute list (signed in).
- **계정** — account and notification settings (signed in).

Sites, from the showcase or a tapped notification, open in the default
browser, where the visitor is already signed in to them as a member. Only
Naru sign-in stays over the app (ASWebAuthenticationSession, a Custom Tab),
since it must return to it.

## Site code

```js
// _naru/mutations/board.js
await ctx.notify([post.author], {
  title: "새 댓글",
  body: text.slice(0, 80),
  path: `/posts/${post.id}`,
});
```

- Mutations only. Rows go to an outbox in the call's transaction, so a failed
  call sends nothing.
- `title` ≤ 100 characters, `body` ≤ 500, `path` a path on the site (no
  scheme or host). Naru adds the site's name and icon; a site cannot set them.
- Members only. Unknown, pending or banned member IDs are skipped silently,
  so the site learns nothing about who has the app.
- At most 1,000 members a call; a site stores at most 1,000 notifications an
  hour, all recipients counted, and the rest are dropped.
- Delivered within about a minute: the `app-notifications` job runs every
  minute.

## Consent

An account receives a site's notifications only after allowing it. The first
notification a site sends to an account that has not decided creates a
`pending` request (shown in the app, not pushed); what the site sends
meanwhile is kept and listed once allowed. Allow → later notifications are
pushed; mute → what it sent is forgotten and later ones are dropped.
Operators can turn a site's notifications off
(`users.app_notifications_disabled`).

## App API (`https://naru.pub/api/app/v1`)

Authenticated requests send `Authorization: Bearer <token>`. Errors are
`{ "error": { "code": "...", "message": "..." } }` with the v1 codes; the apps
treat `AUTH_REQUIRED` (401) as signed out.

### Showcase (no sign-in)

`GET /showcase?page=<n>` →

```json
{
  "sites": [
    { "name": "alice", "url": "https://alice.naru.pub",
      "screenshotUrl": "https://r2.naru.pub/_screenshots/alice.png?v=1792310000000",
      "updatedAt": "2026-10-18T09:00:00Z" }
  ],
  "next": 2
}
```

The same rows as `/sites`: discoverable users with a rendered screenshot,
`site_updated_at` descending, 48 a page; `screenshotUrl` is
`getRenderedSiteUrl`. `next` is null on the last page. Cacheable for a minute.

### Sign-in (authorization code + PKCE)

Sign-in happens on naru.pub, in the system browser, so whatever naru.pub
asks (a password today; TOTP or passkeys later) needs no app release, and the
app never sees the password.

1. The app opens `https://naru.pub/app/authorize?client=<ios|macos|android>&redirect_uri=pub.naru:/auth&state=<random>&code_challenge=<S256>&code_challenge_method=S256`
   in ASWebAuthenticationSession / Custom Tabs. Naru signs the person in with
   its normal session, asks to connect the app, and redirects to
   `pub.naru:/auth?code=…&state=…` (or `?error=access_denied&state=…`).
2. `POST /token` `{ code, verifier, redirectUri }` →
   `{ token, account: { loginName } }`. The code lives 10 minutes and is spent
   by its first exchange, right or wrong. The token (`a.` and 43 characters)
   lasts until revoked: sign-out in the app, or deleting the account; it is
   stored in the Keychain / Android Keystore.

`pub.naru` is a private-use scheme in RFC 8252's form, naru.pub reversed.
Any app can register a scheme, so a code may be seen by another app; PKCE
makes it useless without the verifier, which never leaves the app that
started the sign-in. A claimed HTTPS redirect (Universal Links / App Links on
naru.pub) would close that too. naru.pub already serves
`/.well-known/apple-app-site-association` for team `K4CQ85R27U`, bundle
`pub.naru` (`webcredentials`, which ASWebAuthenticationSession's HTTPS
callback needs, and `applinks` for `/app/callback` only), and the Apple app
declares `webcredentials:naru.pub` and `applinks:naru.pub`; switching its
callback to `https://naru.pub/app/callback` is what remains, and on Android
`assetlinks.json` once the release signing key's fingerprint is known. On
iOS the risk is low already: ASWebAuthenticationSession receives its own
callback whatever other apps registered.

`DELETE /session` revokes the token and removes the devices registered with it.

`GET /me` → `{ account: { loginName } }`.

### Devices

`PUT /devices` `{ platform: "apns" | "fcm", token, environment: "sandbox" | "production", bundleId }`
→ 204. Idempotent; registering a token that belongs to another session moves
it. APNs `environment` follows the build (debug → sandbox); FCM always sends
`production`.

`DELETE /devices/<token>` → 204.

### Notifications

`GET /notifications?before=<id>` →

```json
{
  "notifications": [
    {
      "id": "0199…",
      "site": { "name": "alice", "title": "Alice's board", "url": "https://alice.naru.pub", "iconUrl": "https://…" },
      "title": "새 댓글",
      "body": "…",
      "url": "https://alice.naru.pub/posts/12",
      "createdAt": "2026-10-18T09:00:00Z",
      "readAt": null
    }
  ],
  "next": "0199…" 
}
```

Newest first, 50 per page; `next` is null on the last page. Only allowed
sites' notifications are listed.

`POST /notifications/read` `{ ids: [...] }` or `{ all: true }` → `{ unread }`.

### Sites

`GET /sites` → `{ sites: [{ site: {…}, state: "pending" | "allowed" | "muted", updatedAt }] }`,
pending first.

`PUT /sites/<name>` `{ state: "allowed" | "muted" }` → the updated entry.

## Push payloads

APNs:

```json
{
  "aps": { "alert": { "title": "새 댓글", "subtitle": "Alice's board", "body": "…" },
           "sound": "default", "badge": 3, "thread-id": "alice" },
  "naru": { "id": "0199…", "url": "https://alice.naru.pub/posts/12" }
}
```

FCM (data message, so the app builds the notification and channel itself):

```json
{ "message": { "token": "…", "data": {
  "id": "0199…", "site": "alice", "siteTitle": "Alice's board",
  "title": "새 댓글", "body": "…", "url": "https://alice.naru.pub/posts/12"
}, "android": { "priority": "high" } } }
```

Tapping opens `url` and marks the notification read.

## Control plane

- Routes: `control-plane/src/app/(main)/api/app/v1/`, the consent page
  `/app/authorize`; logic in `control-plane/src/lib/app-api/`.
- Tables (migration `1792318382896_naru_app`): `app_auth_codes`, `app_tokens`
  (hashed), `app_devices` (owned by the token that registered them),
  `app_site_consents`, `app_notifications` (per account, keyed by the outbox
  row so a retried delivery stores once).
- `ctx.notify` queues in the site's `_naru_notify_outbox` (`edge/src/notify.ts`,
  see docs/database.md). The `app-notifications` maintenance job
  (`lib/app-api/delivery.ts`, every minute) takes the Worker's pending sites,
  resolves members to accounts through `site_members`, applies consent,
  stores, acknowledges, then pushes.
- Pushes (`lib/app-api/push.ts`): APNs over Node `http2` with a token-based
  key, FCM v1 with a service-account JWT. `410`, `BadDeviceToken`,
  `DeviceTokenNotForTopic` and FCM `UNREGISTERED` forget the device. A failed
  push is not retried; the notification stays in the inbox.
- Environment: `APNS_KEY_ID`, `APNS_TEAM_ID` and the key, as a file
  (`APNS_PRIVATE_KEY_FILE`; production mounts infra's encrypted
  `AuthKey_<id>.p8` into the worker at `/run/secrets/apns.p8`) or inline
  (`APNS_PRIVATE_KEY`, PEM with `\n`); `FCM_SERVICE_ACCOUNT` (JSON). Without
  them a platform's pushes are skipped.
- naru-dev runs `ctx.notify` like production; nothing delivers there, so the
  rows stay in the site's outbox.

`tools/mock-server.mjs` in naru-pub/apple implements this API with made-up
data, for working on the apps without a control plane.
