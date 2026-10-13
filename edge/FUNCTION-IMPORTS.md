# Site function imports

Callable entry points live in `_naru/functions/<path>.js`. Shared code lives in
`_naru/modules/<path>.js`; it cannot be addressed by a member call. For example:

```js
// _naru/modules/prices.js
export const price = 10;
// _naru/functions/shop/buy.js
import { price } from "../../modules/prices.js";
export function buy(ctx) { return price; }
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
available for correction. Existing sites get an initial snapshot on first call.
Changes made directly to R2 must explicitly invoke the internal `publishFunctions`
operation; ordinary calls do not revalidate mutable files.

The site's Durable Object stores the active revision in SQLite metadata. R2 holds
immutable manifests at `_naru-runtime/<site>/revisions/<sha256>.json` and source
blobs at `_naru-runtime/<site>/blobs/<sha256>.js`. Activation changes only the
pointer after validation and storage finish. Each invocation pins its revision
and loads its complete graph before entering the synchronous SQLite transaction.
QuickJS imports then resolve exclusively from that graph. Read-only execution,
rollback, CPU, memory and host-operation limits apply equally to imported code.

Each graph allows 64 modules and 1 MiB of source; each file allows 256 KiB. A
revision allows 256 files and 4 MiB. Manifests and source hashes are verified on
cold reads. A Durable Object retains at most four manifests and 8 MiB/256 source
blobs in memory. Warm cache hits need no storage validation; eviction, restart
and new source hashes still produce misses. QuickJS instances are fresh per call.

Immutable revisions are currently retained in R2. There is no automatic garbage
collection or owner rollback UI yet. Do not apply an age-only blob lifecycle:
new revisions can reference older blobs. Any future cleanup must retain blobs
referenced by retained manifests and protect in-flight invocations.
