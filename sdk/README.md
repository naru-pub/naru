# @naru-pub/sdk

The [Naru](https://naru.pub) Data SDK as an npm package: a Naru site's
collections, its own queries and mutations, live queries and members, from
its pages; and, under `@naru-pub/sdk/functions`, the types of the site's own
code in `_naru/`. The [reference](https://naru.pub/docs/sdk/1.1.0) and the
guides on naru.pub cover what it does.

The package is the very file Naru serves at
`https://sdk.naru.pub/sdk/<version>/naru.js`, with its declarations. A page
without a build step imports that address and needs nothing from here:

```html
<script type="module">
  import { createNaru } from "https://sdk.naru.pub/sdk/1.1.0/naru.js";
</script>
```

A project with a bundler, a type checker or a Node program installs it:

```bash
npm install @naru-pub/sdk
```

```ts
import { createNaru, NaruError } from "@naru-pub/sdk";
import type { Query, Mutation } from "@naru-pub/sdk/functions";
```

Outside a page on `<site>.naru.pub`, say which site:
`createNaru({ site: "demo" })`. Node needs version 22 or later for live
queries (its built-in WebSocket).

## Bundled or loaded from Naru

Bundled, a site keeps the SDK it was built with until it is built again.
Loaded from `sdk.naru.pub`, it gets the SDK's fixes as Naru serves them, and
[naru-dev](https://www.npmjs.com/package/@naru-pub/dev) can point it at your machine. To keep that
while importing from the package, mark it external and give it the address
of the installed version, for example in Vite:

```js
import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync("node_modules/@naru-pub/sdk/package.json", "utf8"),
);
const sdk = `https://sdk.naru.pub/sdk/${version.replace(/-.*/, "")}/naru.js`;

export default {
  plugins: [
    {
      name: "naru-sdk",
      enforce: "pre",
      resolveId: (id) =>
        id === "@naru-pub/sdk" ? { id: sdk, external: true } : null,
    },
  ],
};
```

## Versions

The package's version is the SDK's: `1.1.0` is `/sdk/1.1.0/naru.js`. While
an SDK version is still being built, the file Naru serves at its address
can change and a published package cannot, so it is published as
prereleases, `1.1.0-dev.1` and on, under the dist-tag `dev`.

## Publishing

From the Naru repository (maintainers): run `pnpm sdk:build` in
`control-plane/` if the SDK changed, set `version` in `sdk/package.json`
(`scripts/build.mjs` refuses a release of an SDK version still being built,
and a prerelease of a frozen one), commit, and push a tag `sdk-v<version>`;
`.github/workflows/publish-sdk.yml` checks and publishes it with the
`NPM_TOKEN` secret. `scripts/check-package.sh <dir>` does the same check
locally.

## License

AGPL-3.0-only, as Naru.
