# SDK 1.2.0

## Being built

1.2.0 is in `VERSIONS` in `scripts/build-sdk.mjs`, so `public/sdk/1.2.0/` is
emitted from `sdk/1.2.0/naru.ts` and can still change. It is served at
`https://sdk.naru.pub/sdk/1.2.0/naru.js`; `/sdk/1/` stays 1.1.0 until 1.2.0 is
frozen, and the docs default to 1.1.0 (`LATEST_VERSION`) until then, with
1.2.0's guides at `/docs/1.2.0/` marked 개발 중. On npm it is published as
prereleases, `@naru-pub/sdk@1.2.0-dev.N` under the dist-tag `dev`.

To freeze it, as 1.1.0 was (sdk-1.1.0-release.md): remove it from
`VERSIONS`, add its checksums to `tests/frozen-sdk.test.mjs`, move
`sdk/aliases.json`'s `1` and `LATEST_VERSION` to it, and publish `1.2.0`.

## What differs from 1.1.0

Everything 1.1.0 does, unchanged: 1.0.0's suite runs against it
(`tests/naru-data-sdk-1.2.0.test.mjs`), and its `functions.d.ts` is 1.1.0's
but for saying that `_naru_uploads` lists no visitor's upload. Added:

- `naru.media.upload(file, { signal, keepOriginal, onProgress })` on the
  client itself: an upload as a visitor, with no token, even while the page
  is signed in. It works only where the site's owner allows visitors'
  uploads in the media library (`users.site_visitor_uploads`; database.md),
  and fails with `ACCESS_DENIED` otherwise.
- `keepOriginal: true` on every upload (owner, member, visitor): the file's
  bytes are sent as given, never shrunk or re-encoded to WebP or JPEG. A
  HEIC photo is still converted, since Naru does not store HEIC.

## Checks

`pnpm test:node` (the SDK in a fake browser, including the 1.2.0 file) and
`pnpm test:data:db` (`members.test.ts`'s visitor uploads: the owner's
setting, image-only, finalizing, the uploader in the library, the address
and site limits, and `_naru_uploads`). No browser or live acceptance pass
has been run against 1.2.0.
