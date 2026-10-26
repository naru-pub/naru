import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { fieldIndex, SCHEMA, USAGE_SCHEMA } from "./query";
import {
  classify,
  interruptedCall,
  reserved,
  sqlFailure,
  statementBudget,
  statements,
  type Kind,
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
    // A dump's snapshot tables and a restore's staging tables (site.ts).
    for (const name of [
      "_cf_KV",
      "__miniflare_do_name",
      "_naru_snap_0",
      "_NARU_STAGE_12",
    ])
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

  test("Naru's view of uploads is read and joined, never written or built on", () => {
    for (const sql of [
      "SELECT id FROM _naru_uploads WHERE type = 'image/png'",
      "SELECT p.id, u.size FROM posts p JOIN _naru_uploads u ON u.url = p.image",
      "SELECT * FROM posts WHERE author IN (SELECT member FROM _naru_uploads)",
      "INSERT INTO images SELECT url FROM _naru_uploads WHERE type = 'image/png'",
    ])
      expect(one(sql), sql).not.toBe("schema");
    for (const sql of [
      "DROP VIEW _naru_uploads",
      "CREATE VIEW v AS SELECT * FROM _naru_uploads",
      "CREATE INDEX i ON _naru_uploads (type)",
      "CREATE VIRTUAL TABLE t USING fts5(name, content='_naru_uploads')",
    ])
      expect(() => one(sql), sql).toThrow(/is Naru's/);
    // SQLite itself writes no view.
    const db = naru();
    db.exec(
      "INSERT INTO _naru_media VALUES ('u1', 'https://x/a.png', 'm1', 'a.png', 'image/png', 10, 0)",
    );
    expect(db.prepare("SELECT member, size FROM _naru_uploads").all()).toEqual([
      { member: "m1", size: 10 },
    ]);
    for (const sql of [
      "DELETE FROM _naru_uploads",
      "UPDATE _naru_uploads SET member = 'owner'",
      "INSERT INTO _naru_uploads (id) VALUES ('x')",
    ])
      expect(() => db.exec(sql), sql).toThrow(/view/);
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
      // A write's conflict clause before its table.
      "UPDATE OR IGNORE meta SET value = 'x' WHERE key = 'entitled_until'",
      "UPDATE OR REPLACE _naru_media SET member = NULL",
      "UPDATE OR ABORT main.meta SET value = 'x'",
      "INSERT OR REPLACE INTO meta VALUES ('k', 'v')",
      // Parenthesized tables, and tables after a function, a subquery, an
      // index hint or a join's constraint in the same list.
      "SELECT * FROM (meta)",
      "SELECT * FROM posts, (meta)",
      "SELECT * FROM (posts JOIN meta)",
      "SELECT * FROM posts JOIN (meta) ON 1",
      "SELECT * FROM json_each('[0]'), meta",
      "SELECT * FROM (SELECT 1) AS x, _naru_media",
      "SELECT * FROM posts INDEXED BY p, meta",
      "SELECT * FROM posts NOT INDEXED, meta",
      "SELECT * FROM posts a JOIN posts b ON a.id = b.id, meta",
      "SELECT * FROM posts a JOIN posts b USING (id), meta",
      'SELECT * FROM "(", meta',
      "UPDATE posts SET title = 1 FROM (meta)",
      "DELETE FROM posts WHERE id IN (SELECT 1 FROM posts, (meta))",
      // An index's table after a schema-qualified name, a full-text table's
      // bare content table, and a rename's new name.
      "CREATE INDEX main.i ON meta (value)",
      "CREATE UNIQUE INDEX IF NOT EXISTS main.i ON meta (value)",
      "CREATE VIRTUAL TABLE f USING fts5(key, value, content=meta)",
      "ALTER TABLE posts RENAME TO _naru_x",
    ])
      expect(() => one(sql), sql).toThrow(/is Naru's/);
    // Their names are fine as columns, aliases and values.
    expect(
      one(
        "SELECT p.meta, p.usage AS documents FROM posts p WHERE kind = 'documents'",
      ),
    ).toBe("read");
    for (const [sql, kind] of [
      [
        "SELECT * FROM posts AS meta, comments usage WHERE meta.id = usage.post",
        "read",
      ],
      [
        "SELECT * FROM posts WHERE a IS NOT DISTINCT FROM b ORDER BY a, meta",
        "read",
      ],
      [
        "SELECT j.value, p.id FROM json_each(?) j, posts p WHERE p.id = j.value",
        "read",
      ],
      [
        "SELECT * FROM (posts p JOIN comments c ON c.post = p.id), tags",
        "read",
      ],
      ["UPDATE OR IGNORE posts SET title = ?", "write"],
      ["ALTER TABLE posts RENAME COLUMN meta TO usage", "schema"],
    ] as const)
      expect(one(sql), sql).toBe(kind);
  });

  test("a statement's verb is found past quoted parentheses", () => {
    // A ')' string once closed the CTE early, so the UNION's SELECT passed
    // for the verb and a DELETE ran as a read-only query.
    const sql = "WITH a AS (SELECT ')' UNION SELECT 1) DELETE FROM posts";
    expect(one(sql)).toBe("write");
    expect(() => one(sql, ["read"])).toThrow(/read-only query cannot write/);
  });
});

describe("a statement the runtime stopped at its step budget", () => {
  // As Naru's workerd throws it (seoul/workerd/): in the object for a read,
  // from the caller's stub for a write, which reset the object.
  const stopped = new Error("interrupted: SQLITE_INTERRUPT");
  const env = { SQLITE_STATEMENT_TIMEOUT_MS: "3000" };

  test("is the site's statement running too long, by the budget when known", () => {
    expect(statementBudget(env)).toBe(3000);
    expect(statementBudget({})).toBeUndefined();
    expect(
      statementBudget({ SQLITE_STATEMENT_TIMEOUT_MS: "0" }),
    ).toBeUndefined();
    expect(sqlFailure(stopped, 3000)).toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      message:
        "This statement ran longer than 3 seconds and was stopped; give it an index or read less.",
    });
    expect(sqlFailure(stopped).message).toBe(
      "This statement ran too long and was stopped; give it an index or read less.",
    );
    expect(sqlFailure(stopped, 1000).message).toMatch(/longer than 1 second /);
    // SQLite's other refusals are as before.
    expect(
      sqlFailure(new Error("no such table: nowhere: SQLITE_ERROR")),
    ).toMatchObject({
      status: 400,
      message: "SQL failed: no such table: nowhere",
    });
  });

  test("is told by its caller after the object reset", () => {
    expect(interruptedCall(stopped, env, "site")).toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      message: expect.stringMatching(
        /^This statement ran longer than 3 seconds/,
      ),
    });
    // A release's migrations: refused for good, as a failed migration is.
    expect(interruptedCall(stopped, env, "migrations")).toMatchObject({
      status: 422,
      code: "INVALID_REQUEST",
      message: expect.stringMatching(
        /^A migration ran longer than 3 seconds and was stopped, so the release changed nothing/,
      ),
      details: { reason: "migration_failed" },
    });
    // One of Naru's own statements is the database being unavailable.
    expect(interruptedCall(stopped, env, "naru")).toMatchObject({
      status: 503,
      code: "UNAVAILABLE",
    });
    expect(
      interruptedCall(new Error("Network connection lost."), env, "site"),
    ).toBeUndefined();
  });
});
