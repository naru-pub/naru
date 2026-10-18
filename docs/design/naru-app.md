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
  of discoverable sites, newest update first, with a search field and a
  최근 / 별표 switch for the sites the person starred. It needs no account, so
  the app is useful (and reviewable) before anyone signs in.
- **알림** — the inbox, or the sign-in prompt when signed out.
- **사이트** — the per-site allow/mute list and the sites the account hid
  (signed in).
- **계정** — account and notification settings, and 계정 삭제, which opens
  naru.pub's `/app/account/delete` (App Store guideline 5.1.1(v)) (signed in).
  The signed-out screen's 나루 계정 만들기 starts the same sign-in, opened
  at `/app/signup` (see **Sign-in**).

Every showcase card and notification has a 숨기기 / 신고하기 menu (guideline
1.2, see **Moderation**).

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
- `title` ≤ 100 characters, `body` ≤ 500 (longer text is cut, since it is
  often what members wrote), `path` a path on the site (no scheme or host).
  Naru adds the site's name and icon; a site cannot set them. A push names
  the site by its address first (custom domain or `<login>.naru.pub`), then
  its title cut to 30 characters: the title is the site's own `<title>`, so
  a site could call itself "Naru" or a bank, but not change its address.
- Best effort: a site whose outbox already holds 10,000 notifications (the
  job has stalled) drops new ones rather than failing the mutation, whose
  write matters more than its notice.
- Members only. Unknown, pending or banned member IDs are skipped silently,
  so the site learns nothing about who has the app.
- At most 1,000 members a call; a site stores at most 1,000 notifications an
  hour, all recipients counted, and the rest are dropped.
- Delivered within a few seconds: the worker checks for queued notifications
  every two seconds, with the every-minute `app-notifications` job as backstop.

## Consent

An account receives a site's notifications only after allowing it. Signing in
to a site as a member (`/members/sign-in`) asks, with a box ticked unless the
account turned the site off before: "<site> 사이트의 알림을 나루 앱으로
받기". Approving sets the site allowed (or muted, unticked), so its first
notification is pushed. The first notification from a site the account never
decided on (it joined before the box, or a page sent no answer) creates a
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
With an app token it leaves out the sites the account hid, and is not cached.

`GET /showcase?q=<search>&page=<n>` searches the same rows: sites whose name
or title contains `q` (case-insensitive, at most 50 characters, else 400). A
site named exactly `q` comes first, and is found even when it is not
discoverable (its address is public; a lookup is not a listing), as long as it
has been published. Its card then has `screenshotUrl` of the placeholder
`/app/no-preview.png`, never a stale render.

Sites operators moderated (`users.site_moderation`, `hidden` or `suspended`)
are in neither the showcase nor any search.

### Stars

Sites a person keeps at hand, under 별표 in 둘러보기, starred from the ☆ on a
card. They are the account's, in `site_stars` (`control-plane/src/lib/site-stars.ts`);
the app's list is `control-plane/src/lib/app-api/stars.ts`.

`PUT /starred-sites/<name>` → 204; `DELETE /starred-sites/<name>` → 204.
`GET /starred-sites` → `{ sites: [{ name, url, screenshotUrl, updatedAt, starredAt }] }`,
showcase cards, newest star first. A starred site is listed whether or not it
is discoverable. Hiding a site unstars it. Signed out, the apps keep stars on
the device (the cards themselves) and star them on the account (`PUT` each)
once it signs in.

### Sign-in (authorization code + PKCE)

1. The app opens `https://naru.pub/app/authorize?client=<ios|macos|android>&redirect_uri=<callback>&state=<random>&code_challenge=<S256>&code_challenge_method=S256`
   in ASWebAuthenticationSession / Custom Tabs. The page has its own bare
   layout (no site navigation or footer, so nothing leads to the supporter
   payment pages, which App Store review forbids reaching from the app) and
   its own sign-in form; a person already signed in to naru.pub can sign out
   there to use another account. Its 나루 계정 만들기 goes to `/app/signup`
   with the same request, as the app's own 나루 계정 만들기 opens the
   sign-in, and signing up comes back to `/app/authorize` signed in. It asks
   to connect the app and redirects to
   `<callback>?code=…&state=…` (or `?error=access_denied&state=…`).
2. `POST /token` `{ code, verifier, redirectUri }` →
   `{ token, account: { loginName } }`. The code lives 10 minutes, is spent
   by its first exchange, right or wrong, and returns only to the callback it
   was asked for. The token (`a.` and 43 characters) lasts until revoked:
   sign-out in the app, or deleting the account; it is stored in the
   Keychain / Android Keystore.

The callback is one of two:

- `https://naru.pub/app/callback`: the iOS and macOS app
  (`.https(host: "naru.pub", path: "/app/callback")`). RFC 8252 §7.2: only an
  app naru.pub names can take it, through its
  `/.well-known/apple-app-site-association` (team `K4CQ85R27U`, bundle
  `pub.naru`: `webcredentials`, which the HTTPS callback needs, and `applinks`
  for `/app/callback` alone) and the app's `webcredentials:naru.pub` and
  `applinks:naru.pub`. naru.pub serves a plain page there for the rare
  browser that opens it.
- `pub.naru:/auth`: Android (until its App Links have the release key's
  fingerprint in `assetlinks.json`), and the Apple app against a development
  server, since only naru.pub is associated with it. A private-use scheme in
  RFC 8252 §7.1's form, naru.pub reversed; any app can register a scheme, so
  a code may be seen by another app, and PKCE makes it useless without the
  verifier, which never leaves the app that started the sign-in.

Sign-in happens on naru.pub, so whatever naru.pub asks (a password today;
TOTP or passkeys later) needs no app release, and the app never sees the
password.

`DELETE /session` revokes the token and removes the devices registered with it.

`GET /me` → `{ account: { loginName } }`.

### Supporter plan (App Store, Google Play)

The apps sell the supporter plan as an auto-renewable subscription in their
store (docs/billing.md, 앱 스토어 구독), and never link to the web's Toss
payment pages. `<store>` is `apple` (iOS and macOS) or `google`.

`GET /supporter?store=<store>` →

```json
{
  "supporter": true, "comp": false, "until": "2026-11-19T00:00:00.000Z",
  "source": "apple",
  "subscription": { "store": "apple", "productId": "pub.naru.supporter.monthly",
    "expiresAt": "2026-11-19T00:00:00.000Z", "autoRenews": true, "status": "active" },
  "purchase": { "allowed": false, "message": "App Store에서 구독 중입니다." },
  "accountToken": "0190f5a2-…",
  "products": ["pub.naru.supporter.monthly", "pub.naru.supporter.yearly"]
}
```

`source` is where the paid time comes from (`comp`, `toss`, `apple`,
`google`, or null). `purchase.allowed` is false beside a Toss plan, a renewing
subscription in either store, or prepaid web time; the app shows `message`
and, for its own store's subscription, the store's subscription management.
Purchases carry `accountToken` (StoreKit `appAccountToken`, Play
`setObfuscatedAccountId`). Play `products` are `supporter:<basePlanId>`.

`POST /supporter/apple` `{ transactions: [{ transaction, renewalInfo? }] }`
(StoreKit 2 `jwsRepresentation`s: a purchase, `Transaction.updates`, or every
`Transaction.currentEntitlements` on restore) and `POST /supporter/google`
`{ purchaseToken }` grant the purchase and answer as `GET /supporter`. 409
when the purchase belongs to another account, 400 when it does not verify.
The app finishes a StoreKit transaction only after this succeeds; Play
purchases are acknowledged by the server.

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

`DELETE /notifications/<id>` → `{ unread }`: deletes one of the account's
notifications, which the apps offer as a swipe and as 알림 삭제 in a
notification's menu. A notification already gone, or another account's, gets
the same answer.

### Sites

`GET /sites` → `{ sites: [{ site: {…}, state: "pending" | "allowed" | "muted", updatedAt }] }`,
pending first.

`PUT /sites/<name>` `{ state: "allowed" | "muted" }` → the updated entry.
Hidden sites are not listed here.

### Moderation

Against objectionable content (guideline 1.2), the apps offer 숨기기 and
신고하기 on every showcase card and notification. Logic:
`control-plane/src/lib/app-api/moderation.ts`.

`PUT /hidden-sites/<name>` → 204: the account no longer sees the site in its
showcase, sites or inbox, and what the site sends it is dropped.
`DELETE /hidden-sites/<name>` → 204 shows it again.
`GET /hidden-sites` → `{ sites: [{ site: {…}, hiddenAt }] }`, newest first.
Signed out, the apps hide sites on the device alone, and hand them to the
account (`PUT` each) once it signs in.

`POST /reports` `{ site, notificationId?, reason }` → `{ hidden }`, with or
without an app token. `reason` is `spam` (스팸·광고), `abuse` (괴롭힘·혐오),
`sexual` (선정적인 내용), `illegal` (불법적인 내용) or `other` (기타).
The report is kept in `app_reports` and posted to the operators' Discord,
with the notification's text when the reporter received it. Signed in, it also
hides the site for the reporter (`hidden: true`); signed out the app hides it
on the device. 20 reports an hour per account, or per address signed out
(the gateway's `X-Real-IP`); past that, 429. The Discord alert links to the site's page in `/admin/moderation`, which
lists reports and sets `users.site_moderation`
(`control-plane/src/lib/site-moderation.ts`), each change recorded in
`site_moderation_actions` with its reason:

- `hidden`: out of the home page, `/sites` and the apps' showcase and search.
  Still served; starred, it stays in 별표 without its screenshot.
- `suspended`: hidden, and not served, however many sites are suspended.
  The edge Worker refuses it on every host with a 410 (the domain table it is
  pushed lists suspended sites); a durable task moves its files, screenshot
  and uploads under `_suspended/` in their buckets, which one fixed Cloudflare
  rule blocks on `r2.` and `media.`, and back when lifted
  (`control-plane/src/lib/site-quarantine.ts`); its owner cannot change its
  files, deploy or apply templates meanwhile; its object is told it has no
  database feature and the control plane refuses its data requests; what it
  sends through `ctx.notify` is dropped, and the apps show neither it nor its
  notifications.

`users.app_notifications_disabled` still turns off only a site's
notifications. The owner's own `users.discoverable` is theirs, not a
moderation switch.

## Push payloads

APNs:

```json
{
  "aps": { "alert": { "title": "새 댓글", "subtitle": "alice.naru.pub · Alice's board", "body": "…" },
           "sound": "default", "badge": 3, "thread-id": "alice" },
  "naru": { "id": "0199…", "url": "https://alice.naru.pub/posts/12" }
}
```

FCM (data message, so the app builds the notification and channel itself):

```json
{ "message": { "token": "…", "data": {
  "id": "0199…", "site": "alice", "siteTitle": "alice.naru.pub · Alice's board",
  "title": "새 댓글", "body": "…", "url": "https://alice.naru.pub/posts/12"
}, "android": { "priority": "high" } } }
```

Tapping opens `url` and marks the notification read.

## Control plane

- Routes: `control-plane/src/app/(main)/api/app/v1/`, the sign-in and consent
  page `/app/authorize`, and `/app/signup` (with `/app/policy` and
  `/app/privacy`) and `/app/account/delete` for the app's links (route group
  `(app)`, its own root layout); logic in `control-plane/src/lib/app-api/`.
- Tables (migration `1792318382896_naru_app`): `app_auth_codes`, `app_tokens`
  (hashed), `app_devices` (owned by the token that registered them),
  `app_site_consents`, `app_notifications` (per account, keyed by the outbox
  row so a retried delivery stores once).
- `ctx.notify` queues in the site's `_naru_notify_outbox` (`edge/src/notify.ts`,
  see docs/database.md). The `app-notifications` maintenance job
  (`lib/app-api/delivery.ts`; the worker's watch every two seconds, the job every
  minute as backstop) takes the Worker's pending sites,
  resolves members to accounts through `site_members`, applies consent,
  stores, acknowledges, then pushes.
- Pushes (`lib/app-api/push.ts`): APNs over Node `http2` with a token-based
  key, FCM v1 with a service-account JWT. `410`, `BadDeviceToken`,
  `DeviceTokenNotForTopic` and FCM `UNREGISTERED` forget the device. A failed
  push is not retried; the notification stays in the inbox.
- Environment: `APNS_KEY_ID`, `APNS_TEAM_ID` and the key, as a file
  (`APNS_PRIVATE_KEY_FILE`; production mounts infra's encrypted
  `AuthKey_<id>.p8` into the worker at `/run/secrets/apns.p8`) or inline
  (`APNS_PRIVATE_KEY`, PEM with `\n`); the FCM service account, as a file
  (`FCM_SERVICE_ACCOUNT_FILE`; production mounts infra's encrypted
  `firebase-service-account.json` at `/run/secrets/fcm.json`) or inline
  (`FCM_SERVICE_ACCOUNT`, JSON). Without them a platform's pushes are skipped.
- naru-dev runs `ctx.notify` like production; nothing delivers there, so the
  rows stay in the site's outbox.

`tools/mock-server.mjs` in naru-pub/apple implements this API with made-up
data, for working on the apps without a control plane.
