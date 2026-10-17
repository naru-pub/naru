# The Data SDK on the mini

The edge Worker's code, served by workerd on kr-seongsu-m4 as
`sdk.naru.pub`: the SDK's files, the data API, live connections and the
control plane's site operations. Hosted pages stay on Cloudflare, whose
Worker serves neither the SDK nor the data API.
`src/seoul.ts` is its entry; `wrangler.seoul.jsonc` only bundles it.

```bash
pnpm build:seoul   # seoul/dist: the bundle, the SDK's files, config.capnp
pnpm test:seoul    # build, then serve it with workerd and check it (smoke.mjs)
```

Serve `seoul/dist` from its own directory:

```bash
workerd serve config.capnp \
  --directory-path site-objects=<where site databases live> \
  --socket-addr http=127.0.0.1:<port>
```

with these in the environment:

| Variable | What |
|---|---|
| `EDGE_WORKER_SECRET` | What the control plane sends for site operations (its `SITE_DATA_SECRET`) and signs live tickets with |
| `PASSTHROUGH_ORIGIN` | The control plane on this host, for requests with a token, such as `http://127.0.0.1:40000` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | The site bucket, where sites' code and its releases are: a key that can read and write it |

How it differs from Cloudflare:

- **Storage.** Each site's database is a SQLite file under `site-objects`. Back
  these up; nothing replicates them.
- **No edge cache.** Visitors' reads are answered by the object each time
  (`EDGE_CACHE=off`), which is a local query here.
- **R2 through its S3 API** (`src/r2-s3.ts`), since workerd has no R2 binding.
- **Visitor addresses.** The proxy in front must set `CF-Connecting-IP` and
  `X-Forwarded-For` to the client's address, replacing whatever the client
  sent: rate limits key on it here and in the control plane.

This host holds the only copy of each site's database; nightly backups to B2
(~/Git/infra) are what recovers it. While it is away, sites' static files are
still served from R2 by Cloudflare, but their data calls fail and their routes
answer with their index.html (status 503). The edge Worker on Cloudflare
probes `https://origin.sdk.naru.pub/healthz/deep` each minute and posts to
Discord when this host has failed three minutes in a row, and again when it
answers: see `docs/database.md`, "When the mini is away".
