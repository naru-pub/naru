import { DataError } from "../../control-plane/src/lib/site-data/validation";
import {
  COMPARISONS,
  filters,
} from "../../control-plane/src/lib/site-data/filters";
import {
  decodeCursor,
  decodeMultiCursor,
  encodeCursor,
  encodeMultiCursor,
  sortings,
  type Sort,
} from "../../control-plane/src/lib/site-data/pagination";
import { createHash } from "node:crypto";
import type { ListInput } from "./types";

// The SQL of a site's object (site.ts), as pure functions: its tables, and
// the list query with Naru's ordering, filters and cursors. Nothing here
// touches storage, so query.test.ts runs it against SQLite in plain Node.

/** A value SQLite binds or returns; the Workers runtime's SqlStorageValue. */
export type SqlValue = ArrayBuffer | string | number | null;
export type Row = Record<string, SqlValue>;

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS _naru_subscriptions (
    socket TEXT NOT NULL,
    id TEXT NOT NULL,
    member TEXT,
    query TEXT NOT NULL,
    args TEXT NOT NULL,
    tables TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (socket, id)
  );
  CREATE TABLE IF NOT EXISTS _naru_roles (
    member TEXT PRIMARY KEY,
    roles TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- ctx.counters' and ctx.session's, released on 2026-10-18 and withdrawn.
  DROP TABLE IF EXISTS _naru_counters;
  DROP TABLE IF EXISTS _naru_sessions;
  CREATE TABLE IF NOT EXISTS _naru_media (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    member TEXT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- What site SQL may read of Naru's (sql.ts READABLE): members' roles, a
  -- row a role, and the uploads Naru Media finished (member null: the owner).
  CREATE VIEW IF NOT EXISTS _naru_member_roles AS
    SELECT _naru_roles.member AS member, json_each.value AS role
    FROM _naru_roles, json_each(_naru_roles.roles);
  CREATE VIEW IF NOT EXISTS _naru_uploads AS
    SELECT id, url, member, name, type, size, created_at FROM _naru_media;
  CREATE TABLE IF NOT EXISTS _naru_breaker_trips (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    file TEXT NOT NULL,
    name TEXT NOT NULL,
    breaker TEXT NOT NULL,
    statement TEXT,
    text TEXT,
    strikes INTEGER NOT NULL,
    until INTEGER NOT NULL,
    repeated INTEGER NOT NULL,
    cleared_at INTEGER,
    notified_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS _naru_migrations (
    name TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    generation TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    read_access TEXT NOT NULL,
    write_access TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    collection_id TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    created_by TEXT,
    PRIMARY KEY (collection_id, id)
  );
  CREATE INDEX IF NOT EXISTS documents_created ON documents (collection_id, created_at, id);
  CREATE INDEX IF NOT EXISTS documents_updated ON documents (collection_id, updated_at, id);
  CREATE TABLE IF NOT EXISTS media_refs (
    upload_id TEXT NOT NULL,
    collection_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    PRIMARY KEY (collection_id, document_id, upload_id)
  );
  CREATE INDEX IF NOT EXISTS media_refs_upload ON media_refs (upload_id);
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  );
`;

/**
 * The index a collection's `indexes` field gets: the field's value, then
 * creation order, so a list that filters on the field, newest or oldest
 * first, reads only its own page. Partial, so only that collection's writes
 * keep it. Collection IDs are UUIDs and fields passed NAME, so both are
 * inlined safely.
 */
export function fieldIndex(collectionId: string, field: string) {
  if (!/^[0-9a-f-]{36}$/.test(collectionId))
    throw new Error("Unexpected collection ID.");
  const index = `documents_index_${createHash("sha256").update(`${collectionId}\u0000${field}`).digest("hex").slice(0, 24)}`;
  return {
    index,
    create: `CREATE INDEX IF NOT EXISTS ${index} ON documents (json_extract(data, '$."${field}"'), created_at, id) WHERE collection_id = '${collectionId}'`,
  };
}

/** Preserve the existing six-digit timestamp cursor format; storage is ms. */
export const cursorTime = (ms: number) =>
  new Date(ms).toISOString().replace("Z", "000Z");
export const cursorMs = (value: string) => Date.parse(value.slice(0, 23) + "Z");

// Naru ordering: null/missing/non-scalars, strings, numbers, booleans. The
// four scalar keys are represented as SQLite columns.
// Strings compare as bytes (SQLite's BINARY collation).
// `field` has passed NAME, so it cannot close the quoted JSON path.
const jsonPath = (field: string) => `'$."${field}"'`;
function fieldOrder(field: string) {
  const type = `json_type(data, ${jsonPath(field)})`;
  const value = `json_extract(data, ${jsonPath(field)})`;
  return [
    `CASE ${type} WHEN 'text' THEN 1 WHEN 'integer' THEN 2 WHEN 'real' THEN 2 WHEN 'true' THEN 3 WHEN 'false' THEN 3 ELSE 0 END`,
    `CASE WHEN ${type} = 'text' THEN ${value} ELSE '' END`,
    `CASE WHEN ${type} IN ('integer', 'real') THEN ${value} ELSE 0 END`,
    `CASE WHEN ${type} = 'true' THEN 1 ELSE 0 END`,
  ];
}
/** The same four keys for a cursor's JSON text, computed here and bound. */
function cursorOrder(text: string): SqlValue[] {
  const value: unknown = JSON.parse(text);
  const rank =
    typeof value === "string"
      ? 1
      : typeof value === "number"
        ? 2
        : typeof value === "boolean"
          ? 3
          : 0;
  return [
    rank,
    typeof value === "string" ? value : "",
    typeof value === "number" ? value : 0,
    value === true ? 1 : 0,
  ];
}
const COLUMNS: Record<string, string> = {
  id: "id",
  createdAt: "created_at",
  updatedAt: "updated_at",
};
const sortKeys = (sort: Sort) =>
  sort.field ? fieldOrder(sort.field) : [COLUMNS[sort.orderBy]];
function cursorKeys(sort: Sort, value: string | null): SqlValue[] {
  if (sort.field) return cursorOrder(value!);
  return [cursorMs(value!)];
}
const tuple = (keys: string[]) =>
  keys.length === 1 ? keys[0] : `(${keys.join(", ")})`;
const placeholders = (count: number) =>
  count === 1 ? "?" : `(${Array(count).fill("?").join(", ")})`;

/** Filters address top-level fields of a document's `data`. */
function filterConditions(filter: ReturnType<typeof filters>) {
  const conditions: string[] = [];
  const bindings: SqlValue[] = [];
  for (const [field, value] of filter.entries) {
    const type = `json_type(data, ${jsonPath(field)})`;
    const extracted = `json_extract(data, ${jsonPath(field)})`;
    // An explicit null matches; a missing field does not.
    if (value === null) conditions.push(`${type} = 'null'`);
    else if (typeof value === "boolean")
      conditions.push(`${type} = '${value ? "true" : "false"}'`);
    else if (typeof value === "string") {
      conditions.push(`${type} = 'text' AND ${extracted} = ?`);
      bindings.push(value);
    } else {
      conditions.push(`${type} IN ('integer', 'real') AND ${extracted} = ?`);
      bindings.push(value);
    }
  }
  for (const [field, operator, bound] of filter.ranges) {
    // Ranges compare within the bound's own JSON type.
    const type = `json_type(data, ${jsonPath(field)})`;
    conditions.push(
      `${type} ${typeof bound === "string" ? "= 'text'" : "IN ('integer', 'real')"} AND json_extract(data, ${jsonPath(field)}) ${COMPARISONS[operator]} ?`,
    );
    bindings.push(bound);
  }
  return { conditions, bindings };
}

/** A stored document as the protocol reports it. */
export function documentOf(row: Row) {
  return {
    id: row.id as string,
    data: JSON.parse(row.data as string),
    version: Number(row.version),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    createdBy: (row.created_by ?? null) as string | null,
  };
}

/**
 * The site's document count and bytes, kept by triggers on every write path,
 * so a write's quota check reads one row instead of every document.
 */
export const USAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    documents INTEGER NOT NULL,
    bytes INTEGER NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS usage_insert AFTER INSERT ON documents BEGIN
    UPDATE usage SET documents = documents + 1, bytes = bytes + NEW.size_bytes WHERE id = 1;
  END;
  CREATE TRIGGER IF NOT EXISTS usage_delete AFTER DELETE ON documents BEGIN
    UPDATE usage SET documents = documents - 1, bytes = bytes - OLD.size_bytes WHERE id = 1;
  END;
  CREATE TRIGGER IF NOT EXISTS usage_update AFTER UPDATE OF size_bytes ON documents BEGIN
    UPDATE usage SET bytes = bytes - OLD.size_bytes + NEW.size_bytes WHERE id = 1;
  END;
`;

type Query = { sql: string; bindings: SqlValue[] };

/**
 * One page of a collection: the statement to run (one row more than the page,
 * to tell whether another follows), the count to run when the total was asked
 * for, and `page`, which turns the statement's rows into the documents and
 * next cursor.
 */
export function listQuery(collectionId: string, input: ListInput) {
  const filter = filters(input.filter);
  const { conditions, bindings } = filterConditions(filter);
  const limit = input.size ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DataError(400, "Page size must be 1–100.");
  const sorts = sortings(input.sort);
  const sort = sorts[0];
  const multiple = sorts.length > 1;
  const cursor = multiple
    ? decodeMultiCursor(input.after, collectionId, sorts, filter.fingerprint)
    : decodeCursor(input.after, collectionId, sort, filter.fingerprint);
  const keys = sorts.map(sortKeys);
  const where = ["collection_id = ?", ...conditions];
  const whereBindings: SqlValue[] = [collectionId, ...bindings];
  const order = sorts.flatMap((item, index) =>
    keys[index].map((key) => `${key} ${item.direction.toUpperCase()}`),
  );
  if (!sorts.some((item) => item.orderBy === "id"))
    order.push(`id ${sorts.at(-1)!.direction.toUpperCase()}`);
  const pageWhere = [...where];
  const pageBindings = [...whereBindings];
  if (cursor) {
    if (!multiple) {
      const single = cursor as { id: string; value: string | null };
      const comparison = sort.direction === "asc" ? ">" : "<";
      if (sort.orderBy === "id") {
        pageWhere.push(`id ${comparison} ?`);
        pageBindings.push(single.id);
      } else {
        const bound = [...cursorKeys(sort, single.value), single.id];
        pageWhere.push(
          `(${[...keys[0], "id"].join(", ")}) ${comparison} ${placeholders(bound.length)}`,
        );
        pageBindings.push(...bound);
      }
    } else {
      const multi = cursor as { id: string; values: string[] };
      const values = sorts.map((item, index) =>
        cursorKeys(item, multi.values[index]),
      );
      const branches: string[] = [];
      for (let index = 0; index <= sorts.length; index += 1) {
        const parts: string[] = [];
        for (
          let before = 0;
          before < Math.min(index, sorts.length);
          before += 1
        ) {
          parts.push(
            `${tuple(keys[before])} = ${placeholders(values[before].length)}`,
          );
          pageBindings.push(...values[before]);
        }
        if (index < sorts.length) {
          const comparison = sorts[index].direction === "asc" ? ">" : "<";
          parts.push(
            `${tuple(keys[index])} ${comparison} ${placeholders(values[index].length)}`,
          );
          pageBindings.push(...values[index]);
        } else {
          parts.push(`id ${sorts.at(-1)!.direction === "asc" ? ">" : "<"} ?`);
          pageBindings.push(multi.id);
        }
        branches.push(`(${parts.join(" AND ")})`);
      }
      pageWhere.push(`(${branches.join(" OR ")})`);
    }
  }
  // Cursor values: a field's JSON text, or a six-digit timestamp.
  const cursorColumns = sorts.map((item, index) =>
    item.orderBy === "id"
      ? `NULL AS cursor_value_${index}`
      : item.field
        ? `coalesce(data -> ${jsonPath(item.field)}, 'null') AS cursor_value_${index}`
        : `${COLUMNS[item.orderBy]} AS cursor_value_${index}`,
  );
  const select: Query = {
    sql: `SELECT id, data, version, created_at, updated_at, created_by, ${cursorColumns.join(", ")}
       FROM documents WHERE ${pageWhere.join(" AND ")}
       ORDER BY ${order.join(", ")} LIMIT ?`,
    bindings: [...pageBindings, limit + 1],
  };
  const count: Query | null = input.includeTotal
    ? {
        sql: `SELECT count(*) AS matched FROM documents WHERE ${where.join(" AND ")}`,
        bindings: whereBindings,
      }
    : null;
  const cursorValue = (row: Row, index: number) => {
    const value = row[`cursor_value_${index}`];
    const item = sorts[index];
    if (item.orderBy === "id") return null;
    return item.field ? (value as string) : cursorTime(Number(value));
  };
  const page = (rows: Row[]) => {
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return {
      documents: shown.map(documentOf),
      nextCursor:
        rows.length > limit && last
          ? multiple
            ? encodeMultiCursor(
                collectionId,
                sorts,
                last.id as string,
                sorts.map((_, index) => cursorValue(last, index) as string),
                filter.fingerprint,
              )
            : encodeCursor(
                collectionId,
                sort,
                last.id as string,
                cursorValue(last, 0),
                filter.fingerprint,
              )
          : null,
    };
  };
  return { select, count, page };
}
