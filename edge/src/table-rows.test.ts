import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { SCHEMA, USAGE_SCHEMA } from "./query";
import {
  ownerQuery,
  QUERY_ROWS,
  siteObjectsOf,
  TABLE_CELL_CHARS,
  TABLE_COUNT_ROWS,
  tableRows,
  type RawRows,
} from "./table-rows";

// A page of a site's table for its owner, against SQLite in plain Node with
// the object's own schema beside the site's.

const site = (sql: string) => {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.exec(USAGE_SCHEMA);
  db.exec(sql);
  const raw: RawRows = (query, ...bindings) => {
    const statement = db.prepare(query);
    statement.setReturnArrays(true);
    return statement.all(...(bindings as never[])) as unknown as unknown[][];
  };
  const objects = () =>
    siteObjectsOf(
      db
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index', 'view') ORDER BY rowid",
        )
        .all() as { type: string; name: string; sql: string }[],
    );
  const page = (input: Record<string, unknown>) =>
    tableRows(raw, objects(), input);
  const query = (text: unknown) =>
    ownerQuery(
      (sql) => {
        const statement = db.prepare(sql);
        statement.setReturnArrays(true);
        return {
          columns: statement.columns().map((column) => column.name),
          rows: statement.iterate() as unknown as Iterable<unknown[]>,
        };
      },
      { text },
    );
  return { db, page, objects, query };
};
const refusal = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    const { status, message } = error as { status: number; message: string };
    return { status, message };
  }
  throw new Error("Not refused.");
};

describe("a site table's rows", () => {
  test("pages by rowid, counting the table on the first page", () => {
    const { db, page } = site(
      "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, views INTEGER)",
    );
    const insert = db.prepare("INSERT INTO posts VALUES (?, ?, ?)");
    for (let id = 1; id <= 5; id++) insert.run(id * 10, `post ${id}`, id);
    db.exec("DELETE FROM posts WHERE id = 30");

    const first = page({ table: "posts", limit: 2 });
    expect(first).toEqual({
      table: "posts",
      columns: ["id", "title", "views"],
      rows: [
        [10, "post 1", 1],
        [20, "post 2", 2],
      ],
      next: 20,
      count: { rows: 4, more: false },
    });
    const second = page({ table: "POSTS", limit: 2, after: first.next });
    expect(second.rows).toEqual([
      [40, "post 4", 4],
      [50, "post 5", 5],
    ]);
    // A full last page says no more follow, and only the first is counted.
    expect(second.next).toBeNull();
    expect(second.count).toBeUndefined();
    expect(page({ table: "posts" }).rows).toHaveLength(4);
  });

  test("shows BLOBs as their size and long text as its start and length", () => {
    const { db, page } = site("CREATE TABLE files (name TEXT, body, note)");
    db.prepare("INSERT INTO files VALUES (?, ?, ?)").run(
      "a",
      new Uint8Array(1234),
      "x".repeat(TABLE_CELL_CHARS + 5),
    );
    db.prepare("INSERT INTO files VALUES (?, ?, ?)").run("b", 1.5, null);
    expect(page({ table: "files" }).rows).toEqual([
      [
        "a",
        { blob: 1234 },
        { text: "x".repeat(TABLE_CELL_CHARS), length: TABLE_CELL_CHARS + 5 },
      ],
      ["b", 1.5, null],
    ]);
  });

  test("pages a table without a rowid by offset, and one whose columns take its names", () => {
    const { db, page } = site(
      `CREATE TABLE tags (key TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID;
       CREATE TABLE odd (rowid TEXT, value);`,
    );
    for (const key of ["c", "a", "b"])
      db.prepare("INSERT INTO tags VALUES (?, 1)").run(key);
    const first = page({ table: "tags", limit: 2 });
    expect(first.rows).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    expect(first.next).toBe(2);
    expect(page({ table: "tags", limit: 2, after: 2 })).toMatchObject({
      rows: [["c", 1]],
      next: null,
    });

    db.prepare("INSERT INTO odd VALUES (?, ?)").run("z", 1);
    db.prepare("INSERT INTO odd VALUES (?, ?)").run("y", 2);
    const odd = page({ table: "odd", limit: 1 });
    expect(odd.rows).toEqual([["z", 1]]);
    expect(page({ table: "odd", limit: 1, after: odd.next }).rows).toEqual([
      ["y", 2],
    ]);
  });

  test("counts a large table only so far", () => {
    const { db, page } = site("CREATE TABLE n (v)");
    db.exec(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${TABLE_COUNT_ROWS + 50}) INSERT INTO n SELECT x FROM c`,
    );
    expect(page({ table: "n", limit: 1 }).count).toEqual({
      rows: TABLE_COUNT_ROWS,
      more: true,
    });
  });

  test("refuses Naru's tables, views, a full-text table's storage and odd pages", () => {
    const { page, objects } = site(
      `CREATE TABLE posts (id INTEGER PRIMARY KEY, body TEXT);
       CREATE VIEW recent AS SELECT * FROM posts;
       CREATE VIRTUAL TABLE search USING fts5(body);`,
    );
    expect(objects().map((object) => object.name)).toEqual([
      "posts",
      "search",
      "recent",
    ]);
    for (const table of [
      "documents",
      "meta",
      "usage",
      "search_content",
      "sqlite_master",
      "nothing",
    ])
      expect(refusal(() => page({ table })).status).toBe(404);
    expect(refusal(() => page({ table: "recent" }))).toEqual({
      status: 400,
      message: "recent is a view, not a table.",
    });
    for (const input of [
      {},
      { table: 1 },
      { table: "posts", limit: 0 },
      { table: "posts", limit: 101 },
      { table: "posts", limit: 1.5 },
      { table: "posts", after: "1" },
      { table: "posts", after: 1.5 },
    ])
      expect(refusal(() => page(input)).status).toBe(400);
    // A full-text table itself is the site's and pages like any other.
    expect(page({ table: "search" })).toMatchObject({
      columns: ["body"],
      rows: [],
      next: null,
    });
  });
});

describe("the owner's console", () => {
  const posts = () => {
    const made = site(
      `CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, cover BLOB);
       INSERT INTO posts VALUES (1, 'first', zeroblob(10)), (2, 'second', NULL);`,
    );
    return made;
  };

  test("reads the site's tables, joins and Naru's readable views", () => {
    const { query } = posts();
    expect(
      query("SELECT id, title, cover FROM posts ORDER BY id DESC -- newest"),
    ).toEqual({
      columns: ["id", "title", "cover"],
      rows: [
        [2, "second", null],
        [1, "first", { blob: 10 }],
      ],
      more: false,
    });
    expect(
      query(
        "WITH t AS (SELECT count(*) AS n FROM posts) SELECT n, (SELECT count(*) FROM _naru_uploads) AS uploads FROM t;",
      ).rows,
    ).toEqual([[2, 0]]);
    expect(query("VALUES (1, 'x')").rows).toEqual([[1, "x"]]);
    expect(query(`SELECT '${"y".repeat(1500)}'`).rows[0][0]).toMatchObject({
      length: 1500,
    });
  });

  test("shows at most QUERY_ROWS rows and says more followed", () => {
    const { db, query } = posts();
    db.exec(
      `WITH RECURSIVE c(x) AS (SELECT 3 UNION ALL SELECT x + 1 FROM c WHERE x < ${QUERY_ROWS + 10}) INSERT INTO posts (id) SELECT x FROM c`,
    );
    const answer = query("SELECT id FROM posts");
    expect(answer.rows).toHaveLength(QUERY_ROWS);
    expect(answer.more).toBe(true);
  });

  test("refuses writes, schema changes, Naru's tables and more than one statement", () => {
    const { db, query } = posts();
    for (const text of [
      "DELETE FROM posts",
      "UPDATE posts SET title = 'x'",
      "INSERT INTO posts (id) VALUES (3) RETURNING id",
      "WITH x AS (SELECT 1) DELETE FROM posts",
      "DROP TABLE posts",
      "CREATE TABLE t (a)",
      "PRAGMA table_info(posts)",
      "ATTACH 'x' AS y",
      "SELECT * FROM documents",
      "SELECT * FROM meta",
      "SELECT 1; DELETE FROM posts",
      "",
      42,
    ])
      expect(refusal(() => query(text)).status).toBe(400);
    expect(db.prepare("SELECT count(*) AS n FROM posts").get()).toEqual({
      n: 2,
    });
  });
});
