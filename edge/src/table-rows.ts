import { DataError } from "../../control-plane/src/lib/site-data/validation";
import type { SqlValue } from "./query";
import { reserved } from "./sql";

/** The most rows one page of a table holds on the control panel. */
export const TABLE_PAGE_ROWS = 100;
/** The characters of a TEXT value a page shows; the rest is its length. */
export const TABLE_CELL_CHARS = 1000;
/** Rows past this are not counted: the first page says "at least". */
export const TABLE_COUNT_ROWS = 10_000;

export type SiteObject = {
  type: string;
  name: string;
  sql: string;
  virtual: boolean;
};

const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * The site's own tables, indexes and views among sqlite_master's rows, in
 * the order they can be created again: tables, then indexes, then views.
 * Naru's are left out, as is a full-text table's own storage (<name>_data,
 * _idx, _content, _docsize, _config), which comes and goes with it: never
 * the site's to list, dump, drop or browse.
 */
export function siteObjectsOf(master: Record<string, unknown>[]): SiteObject[] {
  const order: Record<string, number> = { table: 0, index: 1, view: 2 };
  const rows = master.filter((row) => !reserved(String(row.name)));
  const virtual = new Set(
    rows
      .filter((row) => /^CREATE VIRTUAL TABLE/i.test(String(row.sql)))
      .map((row) => String(row.name).toLowerCase()),
  );
  const shadow = (name: string) =>
    [...virtual].some((table) =>
      ["data", "idx", "content", "docsize", "config"].some(
        (part) => name.toLowerCase() === `${table}_${part}`,
      ),
    );
  return rows
    .filter((row) => !shadow(String(row.name)))
    .sort((a, b) => order[String(a.type)] - order[String(b.type)])
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      sql: String(row.sql),
      virtual: virtual.has(String(row.name).toLowerCase()),
    }));
}

/**
 * A value as a page shows it: NULL, a number or text as they are, a BLOB as
 * its size, and text past TABLE_CELL_CHARS as its start and full length.
 */
export type Cell =
  null | number | string | { blob: number } | { text: string; length: number };

export type TableRows = {
  table: string;
  columns: string[];
  rows: Cell[][];
  /** `after` for the next page, or null on the last. */
  next: number | null;
  /** On the first page: the table's rows, up to TABLE_COUNT_ROWS. */
  count?: { rows: number; more: boolean };
};

/** A query's rows as arrays of values. */
export type RawRows = (query: string, ...bindings: SqlValue[]) => unknown[][];

/**
 * One page of a site table's rows for its owner, read only, in rowid order
 * from after `after` (the last page's `next`). A table without a rowid is
 * paged by offset instead, `after` then the rows already shown. Views,
 * Naru's tables and a full-text table's storage are refused.
 */
export function tableRows(
  raw: RawRows,
  objects: SiteObject[],
  input: { table?: unknown; after?: unknown; limit?: unknown },
): TableRows {
  if (typeof input.table !== "string" || !input.table)
    throw new DataError(400, "table must be a table's name.");
  const name = input.table;
  const object = objects.find(
    (candidate) =>
      candidate.type !== "index" &&
      candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (object?.type === "view")
    throw new DataError(400, `${object.name} is a view, not a table.`);
  if (!object) throw new DataError(404, `The site has no table ${name}.`);
  const limit = input.limit ?? TABLE_PAGE_ROWS;
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > TABLE_PAGE_ROWS
  )
    throw new DataError(
      400,
      `limit must be an integer from 1 to ${TABLE_PAGE_ROWS}.`,
    );
  const after = input.after ?? null;
  if (after !== null && !Number.isSafeInteger(after))
    throw new DataError(400, "after must be the last page's next.");

  const table = quoteName(object.name);
  const columns = raw("SELECT name FROM pragma_table_info(?)", object.name).map(
    (column) => String(column[0]),
  );
  // The rowid by a name no column has, or pages by offset for a table
  // without one.
  const key = /\bWITHOUT\s+ROWID\b/i.test(object.sql)
    ? undefined
    : ["rowid", "_rowid_", "oid"].find(
        (candidate) =>
          !columns.some((column) => column.toLowerCase() === candidate),
      );
  if (!key && after !== null && (after as number) < 0)
    throw new DataError(400, "after must be the last page's next.");
  // Two values a column: its type, or a long text's full length; and the
  // value, a BLOB's size or a long text's start.
  const values = columns
    .map((column) => {
      const quoted = quoteName(column);
      return (
        `CASE WHEN typeof(${quoted}) = 'text' AND length(${quoted}) > ${TABLE_CELL_CHARS} THEN length(${quoted}) ELSE typeof(${quoted}) END, ` +
        `CASE typeof(${quoted}) WHEN 'blob' THEN length(${quoted}) WHEN 'text' THEN substr(${quoted}, 1, ${TABLE_CELL_CHARS}) ELSE ${quoted} END`
      );
    })
    .join(", ");
  // One row past the page tells whether another follows.
  const page = key
    ? after === null
      ? raw(
          `SELECT ${key}, ${values} FROM ${table} ORDER BY ${key} LIMIT ?`,
          (limit as number) + 1,
        )
      : raw(
          `SELECT ${key}, ${values} FROM ${table} WHERE ${key} > ? ORDER BY ${key} LIMIT ?`,
          after as number,
          (limit as number) + 1,
        )
    : raw(
        `SELECT NULL, ${values} FROM ${table} LIMIT ? OFFSET ?`,
        (limit as number) + 1,
        (after as number | null) ?? 0,
      );
  const more = page.length > (limit as number);
  const shown = page.slice(0, limit as number);
  const rows = shown.map((row) =>
    columns.map((_, i): Cell => {
      const type = row[1 + 2 * i];
      const value = row[2 + 2 * i];
      if (typeof type === "number")
        return { text: String(value), length: type };
      if (type === "blob") return { blob: Number(value) };
      if (type === "null") return null;
      return value as number | string;
    }),
  );
  const next = !more
    ? null
    : key
      ? Number(shown[shown.length - 1][0])
      : ((after as number | null) ?? 0) + shown.length;
  const answer: TableRows = { table: object.name, columns, rows, next };
  if (after === null) {
    const counted = Number(
      raw(
        `SELECT count(*) FROM (SELECT 1 FROM ${table} LIMIT ${TABLE_COUNT_ROWS + 1})`,
      )[0][0],
    );
    answer.count = {
      rows: Math.min(counted, TABLE_COUNT_ROWS),
      more: counted > TABLE_COUNT_ROWS,
    };
  }
  return answer;
}
