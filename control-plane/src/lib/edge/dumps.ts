import { createHash } from "node:crypto";
import {
  answerOf,
  requestWorker,
  siteDataWorker,
  type WorkerTarget,
} from "@/lib/edge/client";
import {
  collectDump,
  DUMP_CONTENT_TYPE,
  DumpChecker,
  LineSplitter,
  SITE_TABLE_PREFIX,
  type DumpRow,
} from "@/lib/site-data/dump-format";

// Whole site databases (edge/src/site.ts `dump` and `restore`): NDJSON
// streams (lib/site-data/dump-format.ts), sent and read as they arrive, so
// the control plane never holds a dump; at most a chunk of it.

/** How long a dump or restore may take: a whole site is read and written. */
export const DUMP_TIMEOUT_MS = 15 * 60_000;

const path = (site: string, operation: string) =>
  `/v1/sites/${encodeURIComponent(site)}/${operation}`;

/** A site's dump, as the Worker at `target` streams it. */
export async function fetchDump(
  target: WorkerTarget,
  site: string,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const what = `dump on ${site}`;
  const response = await requestWorker(
    target,
    path(site, "dump"),
    what,
    { body: "{}", contentType: "application/json" },
    signal,
    DUMP_TIMEOUT_MS,
  );
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get("content-type")?.startsWith(DUMP_CONTENT_TYPE)
  )
    // Never a dump: the refusal, as other operations answer it.
    return answerOf<never>(response, what);
  return response.body;
}

/**
 * Sends a dump to the Worker at `target`, whose `restore` fills an empty
 * site with it. The dump is sent as it is read.
 */
export async function sendDump(
  target: WorkerTarget,
  site: string,
  dump: ReadableStream<Uint8Array> | string,
  signal?: AbortSignal,
): Promise<{ rows: number }> {
  const what = `restore on ${site}`;
  return answerOf(
    await requestWorker(
      target,
      path(site, "restore"),
      what,
      { body: dump, contentType: DUMP_CONTENT_TYPE },
      signal,
      DUMP_TIMEOUT_MS,
    ),
    what,
  );
}

/**
 * Tests only: what a dump holds, table by table: rows and an order-free digest of them
 * (the sum of each row's SHA-256, its keys sorted), so two dumps of the same
 * data compare equal however their rows are ordered. Fed a chunk at a time.
 */
export class DumpSummary {
  private splitter = new LineSplitter();
  private checker = new DumpChecker();
  private sums = new Map<string, { rows: number; sum: bigint }>();
  schema: string[] = [];

  push(chunk: Uint8Array) {
    for (const line of this.splitter.push(chunk)) this.line(line);
  }

  /** The summary, once the dump has ended: a dump cut short throws. */
  finish(): Record<string, { rows: number; digest: string }> {
    for (const line of this.splitter.end()) this.line(line);
    this.checker.finish();
    return Object.fromEntries(
      [...this.sums].map(([table, { rows, sum }]) => [
        table,
        { rows, digest: sum.toString(16) },
      ]),
    );
  }

  private line(text: string) {
    const line = this.checker.accept(text);
    if (!line) return;
    if (line.type === "header") {
      this.schema = line.schema;
      return;
    }
    const entry = this.sums.get(line.table) ?? { rows: 0, sum: BigInt(0) };
    entry.rows++;
    entry.sum =
      (entry.sum + BigInt(`0x${rowDigest(line.row)}`)) %
      (BigInt(1) << BigInt(256));
    this.sums.set(line.table, entry);
  }
}
const rowDigest = (row: DumpRow) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(row)
          .sort()
          .map((key) => [key, row[key]]),
      ),
    )
    .digest("hex");

/** Tests only: a site's dump read through DumpSummary, never held. */
export async function summarizeDump(
  target: WorkerTarget,
  site: string,
): Promise<{
  schema: string[];
  tables: Record<string, { rows: number; digest: string }>;
}> {
  const summary = new DumpSummary();
  const reader = (await fetchDump(target, site)).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    summary.push(value);
  }
  const tables = summary.finish();
  return { schema: summary.schema, tables };
}

/**
 * Tests only: a site's dump on the Worker its object lives on, read whole,
 * as its text and its rows: Naru's tables by name, and the site's tables
 * and migrations under `site`.
 */
export async function readSiteDump(site: string) {
  const text = await new Response(
    await fetchDump(siteDataWorker(), site),
  ).text();
  const dump = await collectDump(
    new Response(text).body as ReadableStream<Uint8Array>,
  );
  // Naru's tables, empty ones too (edge/src/types.ts DUMP_TABLES).
  const naru: Record<string, DumpRow[]> = Object.fromEntries(
    ["meta", "collections", "documents", "media_refs", "rate_limits"].map(
      (table) => [table, []],
    ),
  );
  const tables: Record<string, DumpRow[]> = {};
  for (const [table, rows] of Object.entries(dump.tables))
    if (table.startsWith(SITE_TABLE_PREFIX))
      tables[table.slice(SITE_TABLE_PREFIX.length)] = rows;
    else if (!table.startsWith("_naru_")) naru[table] = rows;
  return {
    text,
    rows: dump.rows,
    tables: naru,
    site: {
      schema: dump.schema,
      tables,
      migrations: dump.tables._naru_migrations ?? [],
    },
  };
}

/** Tests only: `restore` on the Worker a site's object lives on. */
export const restoreSiteDump = (
  site: string,
  dump: ReadableStream<Uint8Array> | string,
) => sendDump(siteDataWorker(), site, dump);
