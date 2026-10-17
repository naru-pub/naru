// A site database's dump (edge/src/site.ts `dump`), as NDJSON: one JSON
// value per line, so it is written, sent and read a part at a time and never
// held whole.
//
//   {"type":"header","version":2,"schema":["CREATE TABLE …", …]}
//   {"type":"row","table":"meta","row":{…}}          Naru's tables, by name
//   {"type":"row","table":"site:posts","row":{…}}     the site's own tables
//   {"type":"row","table":"_naru_migrations","row":{…}}
//   {"type":"row","table":"_naru_roles","row":{…}}
//   {"type":"end","rows":<how many row lines>}
//
// A BLOB is { "$base64": … }; a full-text table's rows carry `rowid`. A dump
// without its end line, or with the wrong count there, was cut short and is
// refused. Shared by the edge (writing and restoring) and the control plane
// (moving and comparing).

export const DUMP_VERSION = 2;
export const DUMP_CONTENT_TYPE = "application/x-ndjson";
/** What the site's own tables are prefixed with in a dump's row lines. */
export const SITE_TABLE_PREFIX = "site:";

export type DumpValue = string | number | null | { $base64: string };
/** A row as a dump carries it: a BLOB as { $base64 }. */
export type DumpRow = Record<string, DumpValue>;
export type DumpHeader = { type: "header"; version: number; schema: string[] };
export type DumpRowLine = { type: "row"; table: string; row: DumpRow };
export type DumpEnd = { type: "end"; rows: number };
export type DumpLine = DumpHeader | DumpRowLine | DumpEnd;

/**
 * A dump as `dump` answered it before NDJSON (restore points written until
 * 2026-10): the whole database as one JSON object. Read only, converted to
 * lines by `legacyDumpLines`.
 */
export type LegacyDump = {
  tables: Record<string, DumpRow[]>;
  site?: {
    schema: string[];
    tables: Record<string, DumpRow[]>;
    migrations: DumpRow[];
    roles?: DumpRow[];
  };
};

/** A dump that is not one, or was cut short. */
export class DumpFormatError extends Error {}

/**
 * The longest line read: far above any row (a document is at most 64 KiB, a
 * site row 2 MB), so a stream without newlines is refused before it fills
 * memory.
 */
export const MAX_LINE_CHARS = 16 * 1024 * 1024;

/**
 * Splits bytes into lines as they arrive: a line may span chunks, and so may
 * a character's UTF-8 bytes. Invalid UTF-8 is refused.
 */
export class LineSplitter {
  private decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  private pending: string[] = [];
  private pendingLength = 0;
  constructor(private maxLine = MAX_LINE_CHARS) {}

  /** The lines that `chunk` completes, without their newlines. */
  push(chunk: Uint8Array): string[] {
    let text: string;
    try {
      text = this.decoder.decode(chunk, { stream: true });
    } catch {
      throw new DumpFormatError("The dump is not UTF-8.");
    }
    return this.split(text);
  }

  /** What is left once the bytes end: a last line without its newline. */
  end(): string[] {
    let text: string;
    try {
      text = this.decoder.decode();
    } catch {
      throw new DumpFormatError("The dump is not UTF-8.");
    }
    const lines = this.split(text);
    if (this.pendingLength) lines.push(this.pending.join(""));
    this.pending = [];
    this.pendingLength = 0;
    return lines;
  }

  private split(text: string) {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline < 0) break;
      const piece = text.slice(start, newline);
      if (this.pendingLength + piece.length > this.maxLine)
        throw new DumpFormatError("A line of the dump is too long.");
      if (this.pendingLength) {
        this.pending.push(piece);
        lines.push(this.pending.join(""));
        this.pending = [];
        this.pendingLength = 0;
      } else lines.push(piece);
      start = newline + 1;
    }
    if (start < text.length) {
      const rest = text.slice(start);
      this.pendingLength += rest.length;
      if (this.pendingLength > this.maxLine)
        throw new DumpFormatError("A line of the dump is too long.");
      this.pending.push(rest);
    }
    return lines;
  }
}

const isValue = (value: unknown) =>
  value === null ||
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $base64?: unknown }).$base64 === "string");

/**
 * Checks a dump's lines in order: the header first, rows, the end line last
 * with the count of rows. `accept` answers each header or row; `finish`
 * refuses a dump whose end line never came.
 */
export class DumpChecker {
  private started = false;
  private ended = false;
  rows = 0;

  accept(text: string): DumpHeader | DumpRowLine | null {
    if (!text.trim()) return null;
    if (this.ended)
      throw new DumpFormatError("The dump goes on after its end line.");
    let line: DumpLine;
    try {
      line = JSON.parse(text);
    } catch {
      throw new DumpFormatError("A line of the dump is not JSON.");
    }
    if (!line || typeof line !== "object")
      throw new DumpFormatError("A line of the dump is not an object.");
    if (!this.started) {
      if (
        line.type !== "header" ||
        line.version !== DUMP_VERSION ||
        !Array.isArray(line.schema) ||
        line.schema.some((sql) => typeof sql !== "string")
      )
        throw new DumpFormatError("The dump does not start with its header.");
      this.started = true;
      return line;
    }
    if (line.type === "row") {
      if (
        typeof line.table !== "string" ||
        !line.table ||
        !line.row ||
        typeof line.row !== "object" ||
        Array.isArray(line.row) ||
        !Object.values(line.row).every(isValue)
      )
        throw new DumpFormatError("A row of the dump is not a row.");
      this.rows++;
      return line;
    }
    if (line.type === "end") {
      if (line.rows !== this.rows)
        throw new DumpFormatError(
          `The dump ends after ${this.rows} rows, but says it has ${line.rows}.`,
        );
      this.ended = true;
      return null;
    }
    throw new DumpFormatError("A line of the dump is not one it may have.");
  }

  finish() {
    if (!this.started) throw new DumpFormatError("The dump is empty.");
    if (!this.ended)
      throw new DumpFormatError("The dump is incomplete: it has no end line.");
  }
}

type ByteSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

async function* chunksOf(source: ByteSource): AsyncGenerator<Uint8Array> {
  if (!("getReader" in source)) {
    yield* source;
    return;
  }
  const reader = source.getReader();
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    // A reader that stops early (a refused dump) cancels the rest.
    if (!done) await reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
}

/** The lines of a byte stream, as they arrive. */
export async function* lines(
  source: ByteSource,
  maxLine = MAX_LINE_CHARS,
): AsyncGenerator<string> {
  const splitter = new LineSplitter(maxLine);
  for await (const chunk of chunksOf(source)) yield* splitter.push(chunk);
  yield* splitter.end();
}

/**
 * A dump's header and rows, checked as they arrive (`DumpChecker`): the
 * generator ends normally only once the end line came with the right count,
 * and throws DumpFormatError otherwise. `length` is each line's size in
 * characters, to batch by.
 */
export async function* dumpLines(
  source: ByteSource,
): AsyncGenerator<{ line: DumpHeader | DumpRowLine; length: number }> {
  const checker = new DumpChecker();
  for await (const text of lines(source)) {
    const line = checker.accept(text);
    if (line) yield { line, length: text.length };
  }
  checker.finish();
}

/** A dump in the format before NDJSON, as the lines it would be now. */
export function* legacyDumpLines(
  dump: LegacyDump,
): Generator<{ line: DumpHeader | DumpRowLine; length: number }> {
  if (!dump?.tables || typeof dump.tables !== "object")
    throw new DumpFormatError("The dump has no tables.");
  const row = (table: string, value: DumpRow) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new DumpFormatError("A row of the dump is not a row.");
    return { line: { type: "row" as const, table, row: value }, length: 0 };
  };
  const site = dump.site;
  if (site && !Array.isArray(site.schema))
    throw new DumpFormatError("The dump's schema is not a list.");
  yield {
    line: { type: "header", version: DUMP_VERSION, schema: site?.schema ?? [] },
    length: 0,
  };
  for (const [table, rows] of Object.entries(dump.tables)) {
    if (!Array.isArray(rows))
      throw new DumpFormatError(`The dump's ${table} is not a list.`);
    for (const value of rows) yield row(table, value);
  }
  if (!site) return;
  for (const [table, rows] of Object.entries(site.tables ?? {})) {
    if (!Array.isArray(rows))
      throw new DumpFormatError(`The dump's ${table} is not a list.`);
    for (const value of rows) yield row(`${SITE_TABLE_PREFIX}${table}`, value);
  }
  for (const value of site.migrations ?? []) yield row("_naru_migrations", value);
  for (const value of site.roles ?? []) yield row("_naru_roles", value);
}

/** A dump read whole, for tests and small comparisons: never for a site's data in production. */
export type CollectedDump = {
  schema: string[];
  /** Rows by the table the lines name (`meta`, `site:posts`, …). */
  tables: Record<string, DumpRow[]>;
  rows: number;
};
export async function collectDump(source: ByteSource): Promise<CollectedDump> {
  const collected: CollectedDump = { schema: [], tables: {}, rows: 0 };
  for await (const { line } of dumpLines(source)) {
    if (line.type === "header") collected.schema = line.schema;
    else {
      (collected.tables[line.table] ??= []).push(line.row);
      collected.rows++;
    }
  }
  return collected;
}
