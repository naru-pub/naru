# SDK 1.1.0 release checks

## Frozen

1.1.0 was frozen on 2026-11-01, at the owner's instruction. Its last change
removed the development notice from its header. It is no longer in `VERSIONS`
in `scripts/build-sdk.mjs`; `tests/frozen-sdk.test.mjs` checks its bytes:

```
ef9ed0b6745e67200d9385c4d6a1f8a4c9135c40263a75ae2d6c64f6cda7ff6d  public/sdk/1.1.0/naru.js
f0b5b53a9de75ba05f4fcb4ffb2758cae0df3312c60b18634e998e3c24410cc6  public/sdk/1.1.0/naru.d.ts
0ac893d4e72df03bfea1f682767e7bd32cbf490cc63b6733062d201faa4ff50a  public/sdk/1.1.0/functions.d.ts
```

On npm it is `@naru-pub/sdk` 1.1.0, whose files are these (tag `sdk-v1.1.0`).
A change to what it does ships as a new version, such as 1.1.1. Only Naru's own
moves, such as where its data API is, can change these files by hand, as they
did 1.0.0's ([sdk-1.0.0-release.md](sdk-1.0.0-release.md)).

## What is promised beyond these files

Site code runs on Naru's one runtime, whichever SDK a page loads, so freezing
the files does not pin it. What `functions.d.ts` describes is therefore Naru's
to keep working for every site: each `ctx` member, the QuickJS globals it lists,
`_naru/routes.json` and `routes.js`' answers, as well as the wire routes the
files call (`/api/data/v1/`). The limits it and `naru.d.ts` state are as of the
freeze; a later raise leaves them out of date, not wrong to rely on.

## What differs from 1.0.0

1.0.0 code compiles unchanged against 1.1.0, and 1.0.0's test suite runs against
both (`tests/naru-data-sdk-1.1.0.test.mjs`). Its behavior differs here:

- `NaruError.message` is a short Korean sentence for visitors, and Naru's English
  account is not on the error at all: it stays in the browser's network tab.
- An owner's sign-in is kept in `localStorage`, not `sessionStorage`: it reaches
  the page's other tabs and survives closing the browser, until it ends. The
  key is the same, but a session in `sessionStorage` is not carried over, so an
  owner signed in on a 1.0.0 page signs in again.
- A pending sign-in also keeps the address it left from, to return to it.
- An upload's result also has `id`.

## Checks at the freeze

`pnpm test:node`, `pnpm test:data`, `pnpm test:data:db` and `tests/naru-functions-1.1.0.types.ts`
in CI. The browser fixture (`tests/browser/`) loads 1.0.0 only, so 1.1.0's storage,
member sign-in and live connections have no browser check here.

The live acceptance pass was not run before the freeze, at the owner's
instruction, as it was not for 1.0.0: owner and member sign-in, reload, sign-out,
a query, a mutation, `subscribe()` and an upload have not been checked on a
deployed site against this release's final files.
