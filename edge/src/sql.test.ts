import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { fieldIndex, SCHEMA, USAGE_SCHEMA } from "./query";
import {
  checkPlan,
  classify,
  reserved,
  statements,
  type Kind,
  type PlanStep,
} from "./sql";

// Site SQL's checks against SQLite in plain Node, with the object's own schema.

const naru = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.exec(USAGE_SCHEMA);
  return db;
};
const one = (sql: string, allowed: Kind[] = ["read", "write", "schema"]) => {
  const [first, ...rest] = statements(sql);
  expect(rest).toEqual([]);
  return classify(first.tokens, allowed);
};
const plan = (db: DatabaseSync, sql: string) =>
  db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as PlanStep[];

describe("site SQL", () => {
  test("every object Naru keeps in a site's database is reserved", () => {
    const db = naru();
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex_%'",
      )
      .all()
      .map((row) => String(row.name));
    expect(names.length).toBeGreaterThan(5);
    for (const name of names)
      expect([name, reserved(name)]).toEqual([name, true]);
    expect(
      reserved(fieldIndex("0190f5a0-0000-7000-8000-000000000001", "x").index),
    ).toBe(true);
    for (const name of ["_cf_KV", "__miniflare_do_name"])
      expect(reserved(name)).toBe(true);
    for (const name of ["posts", "usage_stats", "metadata", "comments"])
      expect(reserved(name)).toBe(false);
  });

  test("statements are split outside strings and comments", () => {
    expect(
      statements(
        "CREATE TABLE a (x);\n-- next\nINSERT INTO a VALUES (';')",
      ).map(({ text }) => text.trim()),
    ).toEqual(["CREATE TABLE a (x)", "-- next\nINSERT INTO a VALUES (';')"]);
    expect(
      statements(
        "SELECT 'a;b' -- c;\n; /* d; */ INSERT INTO t VALUES (\"x;\")",
      ).map(({ tokens }) => tokens.map((token) => token.text)),
    ).toEqual([
      ["SELECT", "a;b"],
      ["INSERT", "INTO", "t", "VALUES", "(", "x;", ")"],
    ]);
    expect(() => statements("SELECT 'open")).toThrow(/unclosed quote/);
  });

  test("statements are classified, and only allowed kinds run", () => {
    expect(one("SELECT * FROM posts WHERE id = ?")).toBe("read");
    expect(one("WITH r AS (SELECT 1) SELECT * FROM r")).toBe("read");
    expect(one("INSERT INTO posts (title) VALUES (?) RETURNING id")).toBe(
      "write",
    );
    expect(one("UPDATE posts SET title = ? WHERE id = ?")).toBe("write");
    expect(one("DELETE FROM posts WHERE id = ?")).toBe("write");
    expect(one("CREATE TABLE posts (id INTEGER PRIMARY KEY)")).toBe("schema");
    expect(one("CREATE UNIQUE INDEX IF NOT EXISTS p ON posts (slug)")).toBe(
      "schema",
    );
    expect(one("ALTER TABLE posts ADD COLUMN body TEXT")).toBe("schema");
    expect(
      one(
        "CREATE VIRTUAL TABLE search USING fts5(title, body, tokenize='trigram')",
      ),
    ).toBe("schema");
    expect(
      one(
        "CREATE VIRTUAL TABLE search USING fts5(body, content='posts', content_rowid='id')",
      ),
    ).toBe("schema");
    expect(one("DROP INDEX p")).toBe("schema");
    expect(() => one("UPDATE posts SET x = 1", ["read"])).toThrow(
      /read-only query cannot write/,
    );
    expect(() => one("CREATE TABLE t (x)", ["read", "write"])).toThrow(
      /_naru\/migrations/,
    );
    for (const [sql, message] of [
      ["PRAGMA table_list", /pragmas/],
      ["ATTACH DATABASE 'x' AS y", /attaching/],
      [
        "CREATE TRIGGER t AFTER INSERT ON posts BEGIN SELECT 1; END",
        /triggers/,
      ],
      [
        "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT * FROM r",
        /recursive/,
      ],
      ["INSERT OR ROLLBACK INTO posts VALUES (1)", /transactions/],
      ["BEGIN", /not a statement/],
      ["CREATE TEMP TABLE t (x)", /temporary/],
      ["CREATE VIRTUAL TABLE t USING rtree(id, a, b)", /fts5\) tables only/],
      [
        "CREATE VIRTUAL TABLE t USING fts5(body, content='')",
        /keeps its content/,
      ],
      [
        "CREATE VIRTUAL TABLE t USING fts5(body, contentless_delete=1)",
        /keeps its content/,
      ],
      ["VACUUM", /VACUUM/],
    ] as const)
      expect(() =>
        statements(sql).forEach(({ tokens }) =>
          classify(tokens, ["read", "write", "schema"]),
        ),
      ).toThrow(message);
  });

  test("Naru's tables cannot be named, wherever a table goes", () => {
    for (const sql of [
      "SELECT * FROM documents",
      "SELECT * FROM posts, documents",
      "SELECT * FROM posts p, main.documents d",
      "SELECT * FROM posts JOIN collections ON 1",
      'SELECT * FROM posts WHERE id IN (SELECT id FROM "documents")',
      "INSERT INTO meta VALUES (1, 2)",
      "INSERT INTO posts SELECT * FROM [documents]",
      "UPDATE usage SET bytes = 0",
      "DELETE FROM media_refs",
      "SELECT * FROM sqlite_master",
      "SELECT * FROM pragma_table_info('documents')",
      "CREATE TABLE _naru_x (id)",
      "CREATE INDEX i ON documents (data)",
      "CREATE TABLE t (id REFERENCES documents (id))",
      "DROP TABLE rate_limits",
      "CREATE VIEW v AS SELECT * FROM documents",
    ])
      expect(() => one(sql), sql).toThrow(/is Naru's/);
    // Their names are fine as columns, aliases and values.
    expect(
      one(
        "SELECT p.meta, p.usage AS documents FROM posts p WHERE kind = 'documents'",
      ),
    ).toBe("read");
  });

  test("a plan may scan one table; others are found by key", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE posts (id INTEGER PRIMARY KEY, board TEXT, author TEXT, at INTEGER);
      CREATE INDEX posts_board ON posts (board);
      CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT, level INTEGER);
      CREATE TABLE comments (id INTEGER PRIMARY KEY, post INTEGER, body TEXT);
    `);
    const ok = (sql: string) =>
      expect(() => checkPlan(plan(db, sql)), sql).not.toThrow();
    const refused = (sql: string, message: RegExp) =>
      expect(() => checkPlan(plan(db, sql)), sql).toThrow(message);
    ok("SELECT * FROM posts WHERE board = 'a' ORDER BY at DESC LIMIT 20");
    ok("SELECT * FROM posts JOIN members ON members.id = posts.author");
    ok(
      "SELECT * FROM posts WHERE author IN (SELECT id FROM members WHERE level > 3)",
    );
    ok("SELECT board, count(*) FROM posts GROUP BY board");
    ok("UPDATE posts SET at = 1 WHERE board = 'a'");
    // Comments have no index on post: SQLite would build one per statement
    // (an automatic index), which is one pass, so it is allowed.
    ok("SELECT * FROM posts JOIN comments ON comments.post = posts.id");
    // A full-text table is searched, or read whole only on its own.
    db.exec(
      "CREATE VIRTUAL TABLE search USING fts5(title, body, tokenize='trigram')",
    );
    ok("SELECT rowid FROM search WHERE search MATCH '커뮤니티'");
    ok("SELECT rowid FROM search WHERE body LIKE '%보카도%'");
    ok(
      "SELECT posts.* FROM search JOIN posts ON posts.id = search.rowid WHERE search MATCH 'abc'",
    );
    ok("SELECT rowid FROM search");
    // SQLite reads the full-text table first, then finds posts by key.
    ok("SELECT * FROM posts, search WHERE search.body = posts.board");
    refused("SELECT * FROM posts, search", /read all of posts for every row/);
    // json_each reads one value of the row: as cheap as the value is long.
    db.exec("CREATE TABLE visits (day TEXT PRIMARY KEY, hours TEXT)");
    ok(
      "SELECT j.key, sum(j.value) FROM visits, json_each(visits.hours) AS j GROUP BY j.key",
    );
    ok("SELECT * FROM json_each('[1,2]') j JOIN posts ON posts.id = j.value");
    refused(
      "SELECT * FROM posts, members WHERE members.level > posts.at",
      /members|posts/,
    );
    refused(
      "SELECT *, (SELECT count(*) FROM comments WHERE comments.body LIKE posts.board || '%') FROM posts",
      /subquery would read all of comments/,
    );
  });
});
