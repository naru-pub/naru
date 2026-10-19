# Production deployment

Production runs the images GitHub Actions builds. Every push to `main` runs
[`.github/workflows/main.yml`](../.github/workflows/main.yml) in
[naru-pub/naru](https://github.com/naru-pub/naru), which pushes:

```
ghcr.io/naru-pub/naru-control-plane:git-<commit>-arm64
ghcr.io/naru-pub/naru-control-plane-jobs:git-<commit>-arm64
```

The two images are targets of one multi-stage
[`control-plane/Dockerfile`](../control-plane/Dockerfile). `control-plane` is
the Next.js server built with `output: "standalone"`: only the files the server
uses, without Chromium, pnpm, devDependencies or the build cache. The blue and
green slots run it. `control-plane-jobs` has the CLIs and migrations compiled
to `dist/` by `scripts/build-cli.mjs`, only the dependencies those import (not
Next, React or the other web app packages, which the build refuses), and
Chromium; `worker` and migrations run from it with plain `node`, no
`tsx`.

The deploy itself is kept outside this repository. It deploys a commit only
once that commit's whole CI run has succeeded, tests and the image smoke test
included, and runs the images as they are: nothing compiles on the server.

CI builds with the Dockerfile's default `NEXT_PUBLIC_DOMAIN` (`naru.pub`),
which is compiled into the client bundle, so the images are only right for a
server whose `.env` agrees.

What a release does that the code has to allow for:

- The previous web slot keeps serving while the worker stops and the new
  release's migrations run, and until the new slot is healthy. An ordinary
  release's migrations therefore have to leave the previous release working.
- A breaking migration goes out as a downtime deploy instead, which stops the
  old web slot too; backward compatibility is not required then (see
  `AGENTS.md`). The Absurd payment migration imports existing work and removes
  the old queue; see
  [the payment deployment notes](design/absurd-payments.md#deployment).
- A rollback only switches the web slot back. It does not reverse migrations
  or roll back the worker, so after a breaking migration, fix forward: an
  older image may no longer work with the current schema.

## Edge Worker

The edge Worker ([`edge/`](../edge), deployed as `naru-edge`) serves
hosted sites, their pageviews and custom domains; site databases, and the
Data SDK's files at `sdk.naru.pub/sdk/`, live on the mini
([database.md](database.md#where-site-data-lives)). It is not part of the
images and deploys on its own: Cloudflare Workers Builds deploys it from
`main` (root directory `edge`), on an account on the Workers Paid plan. To set
it up, or deploy by hand from the development machine:

```bash
cd edge
pnpm install
pnpm exec wrangler login
pnpm run deploy
openssl rand -base64 32 | tr -d '\n' | pnpm exec wrangler secret put EDGE_WORKER_SECRET
```

Set `EDGE_WORKER_URL=https://edge.naru.pub` and the same
`EDGE_WORKER_SECRET` in the server's `.env`, then deploy the control
plane so application and background processes read them: pageviews and the
custom domain table use them. Change the secret in both
places together; private `/v1/*` operations require it.

Site databases themselves run on the mini, not here: the same Worker under
workerd, released with `mise run deploy naru-sdk` from infra once CI's
`build-sdk-seoul` job has built it (`edge/seoul/README.md`), and reached by
the control plane at `SITE_DATA_URL` with `SITE_DATA_SECRET`. `sdk.naru.pub`
is DNS-only, straight to the mini, and never reaches this Worker, which
binds no `SiteData` (its class is declared deleted in `wrangler.jsonc`, which
deleted the standby's copies); `wrangler dev --env local` adds it back for
tests (naru-dev runs the mini's Worker, `src/seoul.ts`, instead). The Worker
renders sites' routes there, at `origin.sdk.naru.pub` (secret
`SDK_ORIGIN_SECRET`, the mini's `EDGE_WORKER_SECRET`), and its cron probes
the mini each minute, workerd and the control plane
(`CONTROL_PLANE_HEALTH_URL`, `https://naru.pub/api/health`) apart, and posts
to `DISCORD_WEBHOOK` (secret) when either is down and when it is back: it
alerts, and fails nothing over. See
[database.md](database.md#when-the-mini-is-away).

`wrangler.jsonc` declares the `edge.naru.pub` custom domain and the
hosted-site routes below. naru.pub itself, the control plane, is a DNS-only
record straight to Caddy on the mini (infra `cloudflare/dns_naru_pub.tf`,
`apps/naru-sdk/Caddyfile`), so no Cloudflare route or zone rule sees it: the
control plane answers its data API (`/api/data/v1/*`) itself, and
`naru.pub/sdk/*` is a 404 there. The SDK's committed
`control-plane/public/sdk/` files are served at `sdk.naru.pub/sdk/` by
workerd on the mini (`edge/src/sdk.ts`, bundled by `edge/seoul/`); the
Worker on Cloudflare has neither the files nor the data API, so a hosted
site's own `/sdk/` and `/api/data/v1/` paths are its files.
Cloudflare manages the custom domain's DNS and certificate. Both `workers.dev`
and Preview URLs are disabled. The public route handles every site; the
control plane does not manage per-site Worker routes. The `edge-sync`
maintenance job renews entitlements, sends the custom-domain table, and updates
usage counters every five minutes.

Deploy the Worker before a control plane that relies on what is new in it,
and redeploy it whenever `edge/` or the control-plane modules it
imports (`lib/site-data/validation.ts`, `filters.ts`, `pagination.ts`,
`protocol.ts`, `lib/uuid.ts`) change. When the SDK's files
(`public/sdk/`, `sdk/aliases.json`) change, release naru-sdk (`mise run
deploy naru-sdk` in infra): until then sdk.naru.pub serves the previous SDK.
A change to the object's tables must
create them compatibly with what existing objects already hold.

## Hosted sites at the edge

The same Worker serves hosted sites, `<login>.naru.pub`, straight from the
site bucket `naru-pub` (`edge/src/pages.ts`), so they keep working while the
Mac mini is down. Directories resolve to `index.html`; HTML, JS and JSON come
from the bucket; other files redirect (`302`) to
`https://r2.naru.pub/<login>/<path>`; a directory without its trailing slash
redirects (`308`) to it, keeping the query. A missing site or file is a `404`
and a bucket failure a `502`. It needs no database: a site's files are its
`<login>/` prefix, and deleting an account deletes them.

`r2.naru.pub` serves the whole site bucket, not only sites: any object is
public to whoever knows its key. So each site's code, `<login>/_naru/`, and
what Naru keeps for itself beside the sites, `_naru-runtime/<site>/`
(function releases, the routes the Worker reads, restore points), are in
another bucket, `naru-private`, which no public domain serves
(`PRIVATE_FILES`, `S3_PRIVATE_BUCKET_NAME`, `R2_PRIVATE_BUCKET`). The control
plane names the site bucket for `_naru/` like any of a site's files; its S3
client sends those keys to the private one (`site-code-bucket.ts`). What
else lives in the site bucket either is public on purpose (`_templates/`,
screenshots) or hides behind a random key:
home directory exports are `__exports/<128-bit token>/<login>-export.zip`,
reached through the presigned link in their email, and GitHub deploys stage
under `__deploy_uploads/<user id>/<deployment id>/`. Account deletion removes a
user's exports with their site (its `_naru/` included), and their
`_naru-runtime/<login>/` from the private bucket; the export job deletes any zip no export row points at.

Pages carry `Cache-Control: public, max-age=0, stale-if-error=86400`, a
file's redirect to `r2.naru.pub` `public, max-age=604800, stale-if-error=86400`
(it depends only on the path, and leads to the file as it is now), and a
directory's redirect to its trailing slash `public, max-age=3600,
stale-if-error=86400`, for browsers: Worker responses are not stored in
Cloudflare's cache, so every pageview reaches the Worker. Cloudflare does
cache `r2.naru.pub`, which every edit purges.

What the Worker reads from the bucket, a file or its absence, it keeps in the
data center's cache for `SITE_FILE_CACHE_SECONDS` (`wrangler.jsonc`), so a
busy page is not one bucket read (an R2 Class B operation) per request. The
entry is named by the file's bucket key
(`control-plane/src/lib/edge/file-cache.ts`) and tagged `naru-site-<login>`.
Every control-plane path that changes a site file purges that file's entry
by URL, with its `r2.naru.pub` copy (`control-plane/src/lib/cache-purge.ts`,
`CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_USER_API_TOKEN`); account deletion
purges the site's tag. A failed purge leaves a file stale until its entry
expires, so the lifetime bounds how long an edit can take to appear.

The site bucket has one CORS rule, declared with the rest of Cloudflare in
the infra repository (`cloudflare/r2.tf`): `GET` and `HEAD` from any origin,
preflights cached a day. The
edge's redirects send pages' other files to `r2.naru.pub`, another origin,
and a page reads them across it: web fonts, `fetch`, and a service worker's
`cache.addAll`, which fails whole, and retries on every page load, when one
redirected file is refused. Everything there is public already. After
changing the rule, purge the `r2.naru.pub` hostname, whose cached responses
keep the old headers.

Custom domains are served the same way. The control plane
(`control-plane/src/lib/edge/domains.ts`) sends the Worker the whole table of
domains it serves, through `/v1/domains/replace`: every domain active in
Cloudflare and verified whose owner is complimentary or paid up through the
grace period, mapped to the owner's login, with when that entitlement ends.
The Worker keeps it in KV (`DOMAINS`, one entry) and serves it until its
`confirmedUntil`, three days after the last push. `edge-sync` pushes
it every five minutes, and activating or deleting a domain pushes it at once.
Any host that is neither a site nor a listed custom domain gets a `404` from
the Worker.

Routes decide which requests reach the Worker. `wrangler.jsonc` declares
`*.naru.pub/*` for sites and `*/*`, which catches custom domains: they reach
the zone through Cloudflare for SaaS under their own hostnames. Those routes
would also catch the bucket's public domains, and naru.pub were it proxied
again, so routes without a Worker keep them off (infra
`cloudflare/routes.tf`; by hand, Workers Routes in the zone dashboard, or the
API with a `zone:workers_routes` token):

```bash
for host in naru.pub r2.naru.pub media.naru.pub; do
  curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data "{\"pattern\": \"$host/*\"}"
done
```

The Worker's custom domain `edge.naru.pub` takes precedence over every
route.

The Worker reads the bucket through its `SITE_FILES` binding, and the
private one's `_naru-runtime/<site>/routes.json` through `PRIVATE_FILES`, so
it deploys with a token that can read R2 (Workers Builds' does).

Pageviews go to the Worker's pageview log, one Durable Object, and the
`edge-pageview-drain` job moves them into the pageview tables every minute
([pageview analytics](design/pageview-analytics.md)). While the control plane
is down they wait there, up to six million, and are counted when it is back;
the `edge_pageview_cursors` row keeps a batch from being counted twice. The
job fails, and alerts like any failed job, once the oldest waiting pageview is
more than 30 minutes old.

After a file edit the control plane purges the file's
`https://r2.naru.pub/<login>/<path>` URL and its edge cache entry
(`control-plane/src/lib/cache-purge.ts`), as above.

### Site request limits

Cloudflare bills every request that reaches the edge Worker, whatever it
answers. The `site-request-limits` job (every half hour,
`control-plane/src/lib/edge/site-requests.ts`) counts each site's requests,
its subdomain and custom domains, from the zone's analytics into
`site_request_days`, and keeps a WAF custom rule, ref
`naru-site-request-limit`, blocking every site past its monthly allowance
(`SITE_MONTHLY_PAGE_REQUESTS`, 10,000,000 by default) until the month (UTC)
is over. Cloudflare applies custom rules before the Worker, so a blocked
request is not billed. Supporters' sites are never blocked. The operators'
Discord channel hears when a site passes half its allowance, all of it, and
when a host is blocked or unblocked.

`/admin/firewall` shows this month's busy sites and can block a site
outright or exempt it (`site_request_overrides`), and lists, adds, changes,
turns on and off, and deletes the zone's other custom rules (the free plan
allows five). Each change is told in Discord. The job and the page need
`CLOUDFLARE_USER_API_TOKEN` to have, besides Cache Purge, Zone > Analytics:
Read and Zone > Zone WAF: Edit on naru.pub; without them the job fails and
alerts after three hours.

## Public data caching

The edge Worker caches anonymous reads of world-readable collections
for ten seconds using Cloudflare's Cache API. A zone Cache Rule is not needed
for these Worker responses. The former `Public site data reads` rule can be
removed from the zone configuration.

Owner requests, writes, errors, and `fresh=1` reads are never cached. The SDK
uses `fresh=1` after its own writes for the loaded module's lifetime. Permission
changes may take up to ten seconds to hide previously cached public data.

## Federation worker shutdown

The federation worker aborts its queue listener on SIGTERM, drains heartbeat
work, and closes both the postgres.js client and the shared Kysely pool before
exiting. The image smoke test checks that it exits cleanly within 20 seconds;
deployment still allows 300 seconds for genuinely running work to drain.

The existing worker process now hosts both Fedify and the continuous Absurd
payment worker. On ordinary deployments, the worker stops gracefully while
the active HTTP slot remains serving. The worker drains both listeners before
closing shared databases; Compose's stop grace period is five minutes. The image
smoke test verifies payment-worker startup, drain, and exit code zero. No queue
migration or separate worker service is required.

Payment and maintenance scheduling requires pg_cron installed and preloaded in PostgreSQL.
The deployment CLI connects to `cron.database_name`, creates the extension
there if necessary, and updates the named hourly job with
`cron.schedule_in_database`, targeting the application database and role.
That role needs permission to install/manage pg_cron in its metadata database,
and pg_cron needs database authentication to execute the command. Production
already preloads pg_cron, so this change needs no PostgreSQL restart.
Configuration failure stops deployment before the new background worker starts.

Pageview analytics require the postgresql-hll extension, which keeps distinct
visitors as HyperLogLog sketches ([pageview analytics](design/pageview-analytics.md)).
It needs no preloading; a migration creates it, so the application role must be
allowed to (production's is a superuser). Production's Homebrew PostgreSQL has
it from `brew install postgresql-hll`; on Debian or Ubuntu the package is
`postgresql-<major>-hll`, which CI installs.

The application cron service is retired. The deployment script stops and removes
its old container before migration, preserving database task state. Maintenance
tasks have separate Absurd capacity and stop their child scripts on shutdown so
unfinished attempts can retry. See [the cron replacement](design/cron-replacement.md).
