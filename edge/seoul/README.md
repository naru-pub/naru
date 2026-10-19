# The Data SDK on the mini

The edge Worker's code, served by workerd on kr-seongsu-m4 as
`sdk.naru.pub`: the SDK's files, the data API, live connections and the
control plane's site operations. Hosted pages stay on Cloudflare, whose
Worker serves neither the SDK nor the data API.
`src/seoul.ts` is its entry; `wrangler.seoul.jsonc` only bundles it.

```bash
pnpm build:seoul   # seoul/dist: the bundles, the SDK's files, config.capnp, router.capnp
pnpm test:seoul    # build, then serve it with workerd and check it, alone
                   # (smoke.mjs) and as a router and two shards (smoke-shards.mjs)
NARU_WORKERD_BIN=<Naru's workerd> node seoul/smoke.mjs   # as the mini runs it
```

The mini runs Naru's own workerd: npm's release of the version
`package.json` pins, with one patch that stops a SQLite statement after a
step budget (`workerd/`, whose README says how it is built, published and
checked). CI downloads the build `workerd/binary.json` names, checks it and
packs it into the release in place of npm's.

`seoul/workerd-config.mjs` writes this Worker's config, for the mini here
and for naru-dev (`../naru-dev/`), which runs the same Worker as one local
process.

Serve `seoul/dist` from its own directory:

```bash
workerd serve config.capnp \
  --directory-path site-objects=<where site databases live> \
  --socket-addr http=127.0.0.1:<port>
```

with these in the environment (and, sharded, those under "Shards"):

| Variable | What |
|---|---|
| `EDGE_WORKER_SECRET` | What the control plane sends for site operations (its `SITE_DATA_SECRET`) and signs live tickets with |
| `PASSTHROUGH_ORIGIN` | The control plane on this host, for requests with a token, such as `http://127.0.0.1:40000` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PRIVATE_BUCKET` | The site bucket, where sites' code is, and the private one (`naru-private`), where its releases, routes and restore points are: a key that can read and write both |
| `SITE_BUCKET_URL` | Never on the mini: naru-dev's local site bucket (`src/http-bucket.ts`), read instead of R2 when set; naru-dev's own config (`../naru-dev/scripts/build-worker.mjs`) binds it |
| `WORKERD_SQLITE_STATEMENT_TIMEOUT_MS` | `3000`: Naru's workerd stops any one step of a site's statement after this long (`workerd/`), and the object says so with it; unset or 0, never |

## Shards

workerd runs every object in a process on one thread, so on the mini one
site's slow work would hold up every other. The mini runs several processes
instead (four, October 2026): **shards**, each `config.capnp` with its own
site databases (`site-objects/shard-<i>/`) on its own port (40101 on), and in
front of them the **router** (`src/router.ts`, `router.capnp`) on 40100,
where Caddy, naru's containers and Cloudflare's route renders call as
before. The router has no objects and no SQLite. It:

- answers `/healthz` and the SDK's files (`/sdk/`) itself;
- sends each site's requests to the shard that holds it, as they came
  (headers, `CF-Connecting-IP` and `X-Forwarded-For` among them, bodies and
  answers streamed, live connections' WebSockets passed through): the data
  API, `/api/data/v1/<site>/...`, and the site operations,
  `/v1/sites/<site>/<operation>`, route renders, dumps and restores among
  them. The site is the path's, percent-decoded, as the Worker reads it;
  requests that name none go to shard 0;
- asks every shard for `/healthz/deep` (ok only when each is, else 503 and
  which failed) and for `/v1/breakers/unnotified` (each shard's breakers
  are its own Worker's memory, for its own sites: the union; a shard's
  refusal is the answer, and one that does not answer is left out until the
  next run);
- holds a site's requests for up to 10 seconds while its shard restarts.
  workerd's `fetch` cannot tell a refused connection from one dropped
  mid-request, so a GET is sent again on any failure, and anything else is
  sent once the shard accepts a connection (a TCP probe first) and never
  again: a mutation is never run twice.

Its 404s are the Worker's: nothing else is served (`/v1/pageviews/` and
`/v1/domains/` stay on Cloudflare).

A site's shard is FNV-1a 32-bit of its name's UTF-8 bytes, mod the number of
shards (`src/shards.ts`), unless `NARU_SDK_SHARD_OVERRIDES` names it: a site
moved by hand. The router and every shard are given the same

| Variable | What |
|---|---|
| `NARU_SDK_SHARD_ORIGINS` | Where each shard listens, comma-separated, shard 0 first: `http://127.0.0.1:40101,...` |
| `NARU_SDK_SHARD_OVERRIDES` | JSON, site to shard, `{}` for none |

and each shard its own `NARU_SDK_SHARD` (0, 1, ...): a shard refuses (421)
a site's request that is not its own, rather than open an empty database for
it. Changing the number of shards, or an override, moves sites' files
between shards: a cutover with the SDK stopped (infra's
`naru-sdk-shard-migrate`). Measured with `smoke-shards.mjs` (M-series Mac,
npm's workerd): the router adds about 0.1 ms to a read and 0.15 ms to a
write, and while one shard is stopped outright, sites on another answer
as before.

## How it differs from Cloudflare

- **Storage.** Each site's database is a SQLite file under `site-objects`. Back
  these up; nothing replicates them.
- **A statement's time is bounded.** Cloudflare limits an object's CPU;
  workerd has no such limit and runs every object on one thread, so one
  statement could hold up every site on its shard ("Shards"). Naru's workerd stops it after 3
  seconds instead (`workerd/README.md`). A statement stopped 3 times within a minute
  is paused for 5 minutes (30 when again within the hour), refused before it
  runs (`src/breaker.ts`, `docs/database.md`). The strikes and pauses are in
  the Worker's memory: restarting workerd forgets them. The record of each
  pause is in the site's object, and the control plane's
  `edge-breaker-alerts` job posts each to Discord: this Worker needs no
  webhook.
- **Memory is bounded twice, per process.** Every site's object on a shard
  and the Worker share one isolate in one process, and Cloudflare's per-isolate limit is not
  standalone workerd's. `config.capnp` caps V8's heap at 2 GB
  (`v8Flags`, `--max-old-space-size=2048`, in `build.mjs`): past it V8 aborts
  workerd ("Reached heap limit", signal 6) and launchd starts it again,
  dropping what was in flight. That cap does not count ArrayBuffers or
  SQLite's own memory, so the mini's watchdog (`~/Git/infra`,
  `kr-seongsu-m4/bin/naru-sdk-watchdog`) also kills a shard once its
  footprint has been over 4 GB for 10 seconds (the router's heap is capped
  at 512 MB in `router.capnp`, and the watchdog's limit for it is 1 GB); launchd's
  `HardResourceLimits` cannot, as macOS refuses `RLIMIT_RSS`. In use it is
  about 30 MB (October 2026). The watchdog also restarts a process, and only
  that one, when its `/healthz` has not answered for 30 seconds: stopped statements queued behind each
  other hold the thread one after another (five at once, 12 seconds).
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
probes `https://origin.sdk.naru.pub/healthz/deep` each minute, and
`https://naru.pub/api/health` for the control plane apart, and posts to
Discord when either has failed three minutes in a row, and again when it
answers: see `docs/database.md`, "When the mini is away".
