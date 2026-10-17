// Statements whose work plan.test.ts measures in workerd at N and 4N rows,
// to show the plan rule (plan.ts) right in both directions: what it allows
// reads at most about 4x the rows at 4x the data, and what it refuses for
// growing faster really does grow faster (about 16x for a quadratic).
//
// To add one: write it against SCHEMA (add a table to SCHEMA and its rows to
// `fill` if none fits, keeping every table's size proportional to n), give
// it a `name`, and say what to expect:
//
//   { name, sql, values?, growth: "linear" }               allowed, ≤ 4.5x
//   { name, sql, refused: /message/, growth: "superlinear" } refused, ≥ 8x
//   { name, sql, refused: /message/, growth: "fail-closed", why }
//       refused though it may be linear: the plan does not show what would
//       make it so (its growth is measured but not asserted)
//   { name, sql, growth: "gap", why }
//       allowed though superlinear: a gap the rule knows of (≥ 8x)
//
// Statements run in order against the same tables, so one that writes goes
// near the end and must not change what later ones read. PLAN_REPORT=1
// npx vitest run src/plan.test.ts --silent=false prints each one's rows read
// at both sizes and its verdict.
import type { SqlValue } from "./query";

export type Entry = {
  name: string;
  sql: string;
  values?: SqlValue[];
} & (
  | { growth: "linear" }
  | { growth: "superlinear"; refused: RegExp }
  | { growth: "fail-closed"; refused: RegExp; why: string }
  | { growth: "gap"; why: string }
);

export const SCHEMA = `
  CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, level INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE posts (id INTEGER PRIMARY KEY, board TEXT NOT NULL, author TEXT NOT NULL,
    kind INTEGER NOT NULL, at INTEGER NOT NULL, title TEXT NOT NULL, tags TEXT NOT NULL);
  CREATE INDEX posts_board ON posts (board, at);
  CREATE INDEX posts_author ON posts (author);
  CREATE INDEX posts_kind ON posts (kind);
  CREATE TABLE comments (id INTEGER PRIMARY KEY, post INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE INDEX comments_post ON comments (post, at);
  CREATE TABLE notes (id INTEGER PRIMARY KEY, post INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE TABLE chars (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE titles (ch TEXT NOT NULL, title TEXT NOT NULL, ord INTEGER NOT NULL);
  CREATE INDEX titles_ch ON titles (ch, ord);
  CREATE TABLE visits (day TEXT PRIMARY KEY, hours TEXT NOT NULL);
  CREATE VIRTUAL TABLE search USING fts5(title, body, tokenize='trigram');
  CREATE TABLE kids (id INTEGER PRIMARY KEY, post INTEGER REFERENCES posts (id) ON DELETE CASCADE);
  CREATE TABLE "old posts" (id INTEGER PRIMARY KEY, title TEXT);
`;

/** Rows for SCHEMA's tables, each in proportion to `n` (a multiple of 10). */
export function fill(n: number) {
  const each = (count: number) =>
    `json_each('${JSON.stringify(Array.from({ length: count }, (_, i) => i + 1))}')`;
  const boards = n / 10;
  return [
    `INSERT INTO boards SELECT 'b' || value, 'board ' || value FROM ${each(boards)}`,
    `INSERT INTO members SELECT 'm' || value, 'member ' || value, value % 10 FROM ${each(n)}`,
    `INSERT INTO posts SELECT value, 'b' || (value % ${boards} + 1), 'm' || (value * 7 % ${n} + 1),
       value % 3, value, 'title ' || value, json_array(value % 7, value % 5) FROM ${each(n)}`,
    `INSERT INTO comments SELECT value, value % ${n} + 1, value, 'comment ' || value FROM ${each(n)}`,
    `INSERT INTO notes SELECT value, value, 'note ' || value FROM ${each(n)}`,
    `INSERT INTO chars SELECT 'c' || value, 'char ' || value FROM ${each(n)}`,
    `INSERT INTO titles SELECT 'c' || (value % ${n} + 1), 'title ' || value, value FROM ${each(2 * n)}`,
    `INSERT INTO visits SELECT 'd' || value, json_object('9', value % 5, '10', value % 3) FROM ${each(n)}`,
    `INSERT INTO search (rowid, title, body) SELECT value, 'title ' || value, 'common words ' || value FROM ${each(n)}`,
    `INSERT INTO kids SELECT value, value FROM ${each(n)}`,
    `INSERT INTO "old posts" SELECT value, 'title ' || value FROM ${each(n)}`,
  ];
}

const ids = JSON.stringify(Array.from({ length: 100 }, (_, i) => i * 3 + 1));

export const CORPUS: Entry[] = [
  // Allowed, and linear.
  {
    name: "keyset paging",
    sql: "SELECT id, title FROM posts WHERE id > ? ORDER BY id LIMIT 50",
    values: [5],
    growth: "linear",
  },
  {
    name: "a board's page",
    sql: "SELECT * FROM posts WHERE board = ? ORDER BY at DESC LIMIT 20",
    values: ["b1"],
    growth: "linear",
  },
  {
    name: "posts with their boards",
    sql: "SELECT p.id, b.title FROM posts p JOIN boards b ON b.id = p.board ORDER BY p.id DESC",
    growth: "linear",
  },
  {
    name: "posts per board",
    sql: "SELECT b.id, count(p.id) AS n FROM boards b LEFT JOIN posts p ON p.board = b.id GROUP BY b.id",
    growth: "linear",
  },
  {
    name: "a board's posts with their authors",
    sql: "SELECT p.title, m.name FROM posts p JOIN members m ON m.id = p.author WHERE p.board = ?",
    values: ["b1"],
    growth: "linear",
  },
  {
    name: "an ordered aggregate per row",
    sql: "SELECT c.id, (SELECT json_group_array(title) FROM (SELECT title FROM titles WHERE titles.ch = c.id ORDER BY ord)) AS titles FROM chars c",
    growth: "linear",
  },
  {
    name: "a count per row, by index",
    sql: "SELECT p.id, (SELECT count(*) FROM comments c WHERE c.post = p.id) AS n FROM posts p",
    growth: "linear",
  },
  {
    name: "the latest comment per row",
    sql: "SELECT p.id, (SELECT max(at) FROM comments c WHERE c.post = p.id) AS at FROM posts p",
    growth: "linear",
  },
  {
    name: "json_each sums",
    sql: "SELECT j.key, sum(j.value) AS n FROM visits, json_each(visits.hours) j GROUP BY j.key",
    growth: "linear",
  },
  {
    name: "a row's JSON array",
    sql: "SELECT p.id, j.value FROM posts p, json_each(p.tags) j WHERE p.board = ?",
    values: ["b2"],
    growth: "linear",
  },
  {
    name: "a JSON array as an IN list",
    sql: "SELECT count(*) AS n FROM posts WHERE id IN (SELECT value FROM json_each(?))",
    values: [ids],
    growth: "linear",
  },
  {
    name: "a JSON array joined by key",
    sql: "SELECT p.title FROM json_each(?) j JOIN posts p ON p.id = j.value",
    values: [ids],
    growth: "linear",
  },
  {
    name: "full-text search",
    sql: "SELECT rowid FROM search WHERE search MATCH ? ORDER BY rank LIMIT 20",
    values: ["common"],
    growth: "linear",
  },
  {
    name: "full-text search, then posts by rowid",
    sql: "SELECT p.id, p.title FROM search s JOIN posts p ON p.id = s.rowid WHERE search MATCH ?",
    values: ["common"],
    growth: "linear",
  },
  {
    name: "a trigram LIKE",
    sql: "SELECT rowid FROM search WHERE body LIKE ?",
    values: ["%words 1%"],
    growth: "linear",
  },
  {
    name: "a CTE joined by key",
    sql: "WITH counts AS (SELECT board, count(*) AS n FROM posts GROUP BY board) SELECT b.title, counts.n FROM counts JOIN boards b ON b.id = counts.board",
    growth: "linear",
  },
  {
    name: "a materialized CTE read twice by key",
    sql: "WITH s AS MATERIALIZED (SELECT board, count(*) AS n FROM posts GROUP BY board) SELECT x.board FROM s x JOIN s y ON y.board = x.board",
    growth: "linear",
  },
  {
    name: "a subquery's result found by an automatic index",
    sql: "SELECT b.id, s.n FROM boards b, (SELECT board, count(*) AS n FROM posts GROUP BY board) s WHERE s.board = b.id",
    growth: "linear",
  },
  {
    name: "GROUP BY, ORDER BY",
    sql: "SELECT author, count(*) AS n FROM posts GROUP BY author ORDER BY n DESC, author LIMIT 10",
    growth: "linear",
  },
  {
    name: "DISTINCT",
    sql: "SELECT DISTINCT title FROM posts",
    growth: "linear",
  },
  {
    name: "OR across indexes",
    sql: "SELECT id FROM posts WHERE board = ? OR author = ?",
    values: ["b3", "m8"],
    growth: "linear",
  },
  {
    name: "an unindexed join, by an automatic index",
    sql: "SELECT count(*) AS n FROM posts p JOIN notes n ON n.post = p.id",
    growth: "linear",
  },
  {
    name: "EXISTS, by an automatic index",
    sql: "SELECT count(*) AS n FROM posts p WHERE EXISTS (SELECT 1 FROM notes WHERE notes.post = p.id)",
    growth: "linear",
  },
  {
    name: "an IN list from a table, driving the first loop",
    sql: "SELECT count(*) AS n FROM posts p JOIN members m ON m.id = p.author WHERE p.id IN (SELECT post FROM comments WHERE at > ?)",
    values: [3],
    growth: "linear",
  },
  {
    name: "an IN membership test",
    sql: "SELECT count(*) AS n FROM posts p JOIN members m ON m.id = p.author WHERE m.name IN (SELECT body FROM comments)",
    growth: "linear",
  },
  {
    name: "a window function",
    sql: "SELECT id, row_number() OVER (PARTITION BY board ORDER BY at) AS r FROM posts",
    growth: "linear",
  },
  {
    name: "UNION",
    sql: "SELECT board FROM posts UNION SELECT id FROM boards",
    growth: "linear",
  },
  {
    name: "a scan in a subquery run once",
    sql: "SELECT (SELECT count(*) FROM notes WHERE notes.body = p.title) AS n FROM posts p WHERE p.id = ?",
    values: [1],
    growth: "linear",
  },
  {
    name: "a non-correlated scalar subquery",
    sql: "SELECT id FROM posts WHERE at > (SELECT avg(at) FROM comments) LIMIT 10",
    growth: "linear",
  },
  {
    name: "an UPDATE by an IN list",
    sql: "UPDATE posts SET at = at WHERE id IN (SELECT post FROM comments WHERE at > ?)",
    values: [5],
    growth: "linear",
  },

  // Refused, and superlinear.
  {
    name: "a range join",
    sql: "SELECT count(*) AS n FROM posts a, posts b WHERE a.id > b.id",
    refused: /would search b by a range for every row of a/,
    growth: "superlinear",
  },
  {
    name: "a cross product",
    sql: "SELECT count(*) AS n FROM boards, notes",
    refused: /would read all of boards for every row of notes/,
    growth: "superlinear",
  },
  {
    name: "an unindexed correlated count",
    sql: "SELECT p.id, (SELECT count(*) FROM notes n WHERE n.body = p.title) AS n FROM posts p",
    refused: /a subquery would read all of n for every row of p/,
    growth: "superlinear",
  },
  {
    name: "a correlated range",
    sql: "SELECT p.id, (SELECT count(*) FROM posts q WHERE q.id < p.id) AS n FROM posts p",
    refused: /a subquery would search q by a range for every row of p/,
    growth: "superlinear",
  },
  {
    name: "a MATCH for every row",
    sql: "SELECT count(*) AS n FROM posts p, search WHERE search MATCH 'common' || substr(p.title, 1, 0)",
    refused: /would search all of search for every row of p/,
    growth: "superlinear",
  },
  {
    name: "a MATCH in a correlated subquery",
    sql: "SELECT p.id, (SELECT count(*) FROM search WHERE search MATCH 'common' || substr(p.title, 1, 0)) AS n FROM posts p",
    refused: /a subquery would search all of search for every row of p/,
    growth: "superlinear",
  },
  {
    name: "an IN list from a table, driving a later loop",
    sql: "SELECT count(*) AS n FROM posts p CROSS JOIN posts q WHERE q.id IN (SELECT post FROM comments)",
    refused:
      /would search q once for every value of a list read from a table for every row of p/,
    growth: "superlinear",
  },
  {
    name: "an IN list from an index, driving a later loop",
    sql: "SELECT count(*) AS n FROM posts p CROSS JOIN posts q WHERE q.board IN (SELECT id FROM boards) AND q.at = p.at",
    refused:
      /would search q once for every value of a list read from a table for every row of p/,
    growth: "superlinear",
  },
  {
    name: "a co-routine run again for every row",
    sql: "SELECT count(*) AS n FROM notes, (SELECT board, count(*) AS c FROM posts GROUP BY board)",
    refused: /would read all of posts for every row of notes/,
    growth: "superlinear",
  },
  {
    name: "a materialized CTE read whole for every row",
    sql: "WITH s AS MATERIALIZED (SELECT * FROM notes) SELECT count(*) AS n FROM posts, s",
    refused: /would read all of posts for every row of s/,
    growth: "superlinear",
  },

  // Refused by design: the plan does not show what keeps them linear.
  {
    name: "a correlated range with LIMIT 1",
    sql: "SELECT p.id, (SELECT q.id FROM posts q WHERE q.board = p.board AND q.at < p.at ORDER BY q.at DESC LIMIT 1) AS previous FROM posts p",
    refused: /a subquery would search q by a range for every row of p/,
    growth: "fail-closed",
    why: "the plan does not show the LIMIT that stops the range after one row",
  },
  {
    name: "an IN membership test by a table's index, after a lookup",
    sql: "SELECT count(*) AS n FROM posts p JOIN members m ON m.id = p.author WHERE m.name IN (SELECT id FROM boards)",
    refused:
      /would search m once for every value of a list read from a table for every row of p/,
    growth: "fail-closed",
    why: "the plan does not say whether an IN read from an index drives the loop before it or tests its rows",
  },
  {
    name: "a CTE made once inside a correlated subquery",
    sql: "WITH s AS MATERIALIZED (SELECT post FROM notes) SELECT p.id, (SELECT count(*) FROM s WHERE s.post = p.id) AS n FROM posts p",
    refused: /a subquery would read all of notes for every row of p/,
    growth: "fail-closed",
    why: "the plan does not say whether a result inside a correlated subquery is made once or for every row",
  },
  {
    name: "a step of a shape the rule does not know",
    sql: 'SELECT count(*) AS n FROM "old posts"',
    refused: /its plan has a step Naru does not cost \("SCAN old posts"\)/,
    growth: "fail-closed",
    why: "a table name with a space is not a plan step's name the rule reads",
  },

  // Allowed though superlinear: the known gap.
  {
    name: "a self-join on a value many rows share",
    sql: "SELECT count(*) AS n FROM posts p1 JOIN posts p2 ON p2.kind = p1.kind",
    growth: "gap",
    why: "an equality on an index that is not unique counts as a key, however many rows share the value",
  },

  // Last: they write.
  {
    name: "an INSERT from a JSON array",
    sql: "INSERT INTO notes (post, body) SELECT value, 'more' FROM json_each(?)",
    values: [ids],
    growth: "linear",
  },
  {
    name: "a delete cascading to an unindexed child",
    sql: "DELETE FROM posts WHERE id > ?",
    values: [0],
    refused: /would read all of kids for every row of posts/,
    growth: "superlinear",
  },
];
