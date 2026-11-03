# The Data SDK under load, on workerd

What the mini's stack takes: the router in front of four workerd shards, as
`edge/seoul/loadtest.mjs` serves them (`pnpm loadtest:seoul`). The raw numbers
are in `naru-sdk-workerd.json`. Recorded 2026-11-03.

**What this is not.** It ran on a development Mac (Mac17,2, 10 cores, 24 GB)
with the load generator on the same machine, not on the mini (16 GB, shared
with Postgres, the control plane and other apps), so read the numbers as
ratios and limits, not as the mini's capacity. It used npm's workerd, without
the 3-second statement budget. Caddy, TLS, the network and R2 are not
measured. **Neither is the control plane**, which every request with a token
goes through first: its Postgres pool may well be reached first.

## The limit that came first: POSTs through the router

For each non-GET, the router asks the shard whether it is up, so that a
restarting shard's writes wait rather than fail (`listening` in
`edge/src/router.ts`). It used to open and close a socket of its own for that.
Each closed socket held an ephemeral port in TIME_WAIT for 30 seconds, and
macOS has 16,384 of them, so the machine could sustain about 546 of these a
second. Visitors' queries and mutations, and everything the control plane
sends, are POSTs. Once the ports ran out in a first run, new connections
anywhere on the machine failed with `EADDRNOTAVAIL`.

It now asks with `fetch`, over the connections `fetch` keeps. 60 seconds of
visitors' queries through the router, 16 callers:

|                         | Requests/s | p50 ms | p99 ms | Max ms | 502s |
| ----------------------- | ---------- | ------ | ------ | ------ | ---- |
| A socket for each write | 508        | 5.19   | 24.82  | 10,133 | 35   |
| No check at all         | 2,835      | 4.75   | 19.72  | 80     | 0    |
| `/healthz` over `fetch` | 2,807      | 4.80   | 20.46  | 75     | 0    |

The check costs about 1%. TIME_WAIT sockets stayed at 150 or fewer, and the
write still waits for a restarting shard (`smoke-shards.mjs`).

## Throughput

Closed-loop, 1,000 sites of 100 documents and 1,000 rows. The best rate of 4,
16, 64 and 256 callers, and latency at 16:

| Scenario                     | Best requests/s | p50 ms at 16 | p99 ms at 16 |
| ---------------------------- | --------------- | ------------ | ------------ |
| Read, via router             | 12,849          | 0.93         | 14.13        |
| List, via router             | 9,000           | 2.44         | 12.90        |
| Read, direct                 | 25,307          | 0.65         | 5.65         |
| Query (QuickJS), direct      | 3,399           | 3.99         | 19.33        |
| Owner write, direct          | 15,105          | 1.06         | 9.00         |
| Mutation (QuickJS), direct   | 2,831           | 5.64         | 25.13        |
| Mix, via router              | 8,451           | 1.80         | 13.07        |
| Mix, direct                  | 9,886           | 1.24         | 10.04        |
| Mix, Zipf-busy sites, direct | 9,043           | 1.27         | 10.52        |
| Mix, one site, direct        | 3,833           | 2.59         | 10.72        |
| Read, one site, via router   | 7,629           | 1.32         | 17.89        |

The mix is 70% reads, 12% lists, 12% queries, 3% writes and 3% mutations.

- **The router is a limit of its own.** It runs on one thread, at 0.9 cores by
  the top of the read ladder, and halves what the shards can read.
- **Site code costs the most.** A query is about 7 times a read's cost.
- **One site is limited to its shard's one thread**, as designed; the per-site
  limits did not refuse anything here.

## Isolation

Reads at a site, while the sites beside it on one shard ran scans of 450,000
rows (about 6 ms each, one after another):

|                   | Requests/s, quiet | Requests/s, loud | p99 ms, quiet | p99 ms, loud |
| ----------------- | ----------------- | ---------------- | ------------- | ------------ |
| On the same shard | 8,028             | 1,334            | 0.79          | 7.87         |
| On another shard  | 8,034             | 8,147            | 0.79          | 0.88         |

Shards isolate as intended. Within one, this cost a neighbour 83% of its
throughput. These scans are not the worst case: a single statement may run
for 3 seconds, which needs Naru's workerd to test.

## What each site costs

|                                 | 1,000 sites | 10,000 sites |
| ------------------------------- | ----------- | ------------ |
| Shards' memory, every site used | 668 MB      | 3,189 MB     |
| Memory per site used            | 493 KB      | 308 KB       |
| The same, after 30 s idle       | 648 MB      | 2,440 MB     |
| A site's first request, p50     | 14 ms       | 11 ms        |
| A site's first request, p99     | 81 ms       | 89 ms        |
| Backup's copy and archive       | 4.8 s       | 46.5 s       |
| Sites a five-minute round holds | 62,000      | 65,000       |
| Archive                         | 31 MB       | 177 MB       |

- **Backups scale with every site**, about 4.6 ms each, on an idle machine and
  before the upload. These databases are small; real ones take longer.
- **Memory** tells only of the first 30 seconds' idle. At 308 KB, a shard
  reaches the watchdog's 4 GB at about 13,000 recently used sites; how long
  idle sites stay in memory needs a longer run.
- **Disk per site is unsettled:** 40 KB in the first run and 151 KB in the
  second, which had fewer documents. Nothing here explains that yet.

## Not measured yet

The control plane and Postgres, which matter for every signed-in request; live
connections; Naru's workerd and its statement budget; the mini itself; R2's
latency on a site's first call.
