# Site function imports

Callable entry points live in `_naru/functions/<path>.js`. Shared code lives in
`_naru/modules/<path>.js`; it cannot be addressed by a member call. For example:

```js
// _naru/modules/prices.js
export const price = 10;
// _naru/functions/shop/buy.js
import { price } from "../../modules/prices.js";
export function buy(ctx) {
  return price;
}
```

Call `member.call("shop/buy:buy")` or `member.read("shop/buy:buy")`. Static
relative imports and re-exports, including cycles, are supported. Include `.js`.
Paths stay inside the functions/modules directories. Package names, URL imports,
dynamic imports and top-level await are rejected. No filesystem, network, Node
APIs or package installer are exposed to the interpreter. Transpile TypeScript
before uploading; bundling JavaScript is unnecessary.

Each file operation affecting these directories publishes a snapshot; template
installation and GitHub deployment publish once after all their files are ready.
Upload dependencies before entry points when uploading individual files. Failed
publication leaves the previous revision active and the edited working files
available for correction. Existing sites get an initial snapshot on first call, published by the control plane.
Changes made directly to R2 must explicitly invoke the control-plane publisher;
ordinary calls do not revalidate mutable files.

The control plane creates snapshots and records releases in PostgreSQL's
`site_function_releases` table. Publication and an Absurd `function-release-v1`
task commit together. The control plane sends an authenticated `activateFunctions`
RPC to the site's Durable Object, which stores the active pointer and release
generation in SQLite. Older task retries cannot replace a newer generation.
The durable task retries activation if the inline RPC fails. R2 holds
a complete copy of each release under `_naru-runtime/<site>/revisions/<revision>/`:
`manifest.json`, `functions/<path>.js`, and `modules/<path>.js`. Every publication
gets a new revision, including unchanged releases. The manifest records source
hashes for integrity; sources are never shared between revision directories.
The manifest is written last, after all source uploads succeed. Activation changes
only the pointer after validation and storage finish. Each invocation pins its revision
and loads its complete graph before entering the synchronous SQLite transaction.
QuickJS imports then resolve exclusively from that graph. Read-only execution,
rollback, CPU, memory and host-operation limits apply equally to imported code.

Each graph allows 64 modules and 1 MiB of source; each file allows 256 KiB. A
revision allows 256 files and 4 MiB. Manifests and source hashes are verified on
cold reads. A Durable Object retains at most four manifests and 8 MiB/256 source
blobs in memory. Warm cache hits need no storage validation; eviction, restart
and new source hashes still produce misses. QuickJS instances are fresh per call.

After activation, the Absurd task waits five minutes and deletes the previous
release's entire directory through the control plane's S3 client, then removes
its release row. There are no edge cleanup endpoints, alarms, reader leases or
cross-revision source references. Temporary deletion failures retry without
acknowledging completion, including partial S3 deletion failures. Sleeping and
completed steps survive worker restarts. Unfinished tasks remain durable.

Rapid releases briefly retain several revisions; once tasks finish, only the
latest release remains. This intentionally allows a call still loading an old
revision after the grace period to fail; retrying uses the active revision.
Imports load before the database transaction, so missing imports do not leave
partial writes. A rollback must publish a new revision and generation. In-memory
source caching may reuse identical hashes without storage dependencies.
