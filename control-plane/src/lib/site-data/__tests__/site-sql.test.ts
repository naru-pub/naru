/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { callSiteObject } from "@/lib/edge/client";

// Site SQL (1.1.0) end to end in the site's Durable Object
// (scripts/with-edge-worker.sh): migrations applied with a release, ctx.sql
// in functions, and the site's tables carried by dump and restore.
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;

const site = "sqlsite";
const ownerId = "0190f5a0-0000-7000-8000-0000000000aa";
const put = (
  folder: string,
  file: string,
  source: string | null,
  publish = true,
) =>
  callSiteObject(site, "putFunctions", { site, folder, file, source, publish });
const call = (name: string, args: unknown = null, member = "member-1") =>
  callSiteObject<{ result: unknown }>(site, "call", {
    ownerId,
    site,
    member,
    file: "posts",
    name,
    args,
  }).then((answer) => answer.result);

const POSTS = `
export const readOnly = ["list", "sneak", "naru", "cross"];
export async function add(ctx, { title, board }) {
  const { rows } = await ctx.sql\`INSERT INTO posts (title, board, author) VALUES (\${title}, \${board}, \${ctx.member.id}) RETURNING id\`;
  return rows[0].id;
}
export async function list(ctx, { board }) {
  return (await ctx.sql("SELECT id, title FROM posts WHERE board = ? ORDER BY id", [board])).rows;
}
export async function sneak(ctx) { await ctx.sql\`DELETE FROM posts\`; }
export async function naru(ctx) { return (await ctx.sql\`SELECT * FROM documents\`).rows; }
export async function cross(ctx) {
  return (await ctx.sql\`SELECT count(*) AS n FROM posts a, posts b WHERE a.id > b.id\`).rows;
}
`;

integration("site SQL", () => {
  test("a release's migrations make tables that functions use with ctx.sql", async () => {
    await callSiteObject(site, "erase", {});
    await put(
      "migrations",
      "0001_posts",
      `CREATE TABLE posts (
         id INTEGER PRIMARY KEY,
         title TEXT NOT NULL,
         board TEXT NOT NULL,
         author TEXT
       );
       CREATE INDEX posts_board ON posts (board);`,
      false,
    );
    await put("functions", "posts", POSTS);
    expect(await call("add", { title: "첫 글", board: "free" })).toBe(1);
    expect(await call("add", { title: "둘째", board: "free" })).toBe(2);
    expect(await call("add", { title: "공지", board: "notice" })).toBe(3);
    expect(await call("list", { board: "free" })).toEqual([
      { id: 1, title: "첫 글" },
      { id: 2, title: "둘째" },
    ]);
    // A read-only call cannot write, Naru's tables cannot be named, and a
    // statement that would read a table once per row is refused.
    await expect(call("sneak")).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/read-only query cannot write/),
    });
    await expect(call("naru")).rejects.toMatchObject({
      message: expect.stringMatching(/documents is Naru's/),
    });
    await expect(call("cross")).rejects.toMatchObject({
      message: expect.stringMatching(/would search b by a range/),
    });
  });

  test("an applied migration cannot change, and a failing one changes nothing", async () => {
    await expect(
      put(
        "migrations",
        "0001_posts",
        "CREATE TABLE posts (id INTEGER PRIMARY KEY);",
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(
        /0001_posts\.sql has been applied and cannot be changed/,
      ),
      details: { reason: "migration_failed", migration: "0001_posts.sql" },
    });
    // Put back as applied, then a second migration whose last statement fails.
    await put(
      "migrations",
      "0001_posts",
      `CREATE TABLE posts (
         id INTEGER PRIMARY KEY,
         title TEXT NOT NULL,
         board TEXT NOT NULL,
         author TEXT
       );
       CREATE INDEX posts_board ON posts (board);`,
      false,
    );
    await expect(
      put(
        "migrations",
        "0002_body",
        "ALTER TABLE posts ADD COLUMN body TEXT; INSERT INTO nowhere VALUES (1);",
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(
        /0002_body\.sql failed: .*no such table: nowhere/,
      ),
    });
    // The ALTER went back with it: the release before still serves.
    await put("migrations", "0002_body", null, false);
    await put("functions", "posts", POSTS);
    expect(await call("list", { board: "notice" })).toEqual([
      { id: 3, title: "공지" },
    ]);
    // Migration SQL is held to the same names and plans as ctx.sql.
    for (const [sql, message] of [
      ["DELETE FROM documents;", /documents is Naru's/],
      ["PRAGMA writable_schema = 1;", /pragmas are Naru's/],
      [
        "UPDATE posts SET author = (SELECT b.title FROM posts b WHERE b.title > posts.title LIMIT 1);",
        /subquery would read all of/,
      ],
    ] as const) {
      await expect(put("migrations", "0002_bad", sql)).rejects.toMatchObject({
        status: 422,
        message: expect.stringMatching(message),
      });
      await put("migrations", "0002_bad", null, false);
    }
    await put("functions", "posts", POSTS);
  });

  test("a dump carries the site's tables, and restore makes them again", async () => {
    const dump = await callSiteObject<{
      site: {
        schema: string[];
        tables: Record<string, unknown[]>;
        migrations: { name: string }[];
      };
    }>(site, "dump", {});
    expect(dump.site.schema).toEqual([
      expect.stringMatching(/^CREATE TABLE posts/),
      "CREATE INDEX posts_board ON posts (board)",
    ]);
    expect(dump.site.tables.posts).toHaveLength(3);
    expect(dump.site.migrations.map((row) => row.name)).toEqual([
      "0001_posts.sql",
    ]);
    const copy = "sqlsite-copy";
    await callSiteObject(copy, "erase", {});
    await callSiteObject(copy, "restore", dump);
    const again = await callSiteObject<typeof dump>(copy, "dump", {});
    expect(again.site).toEqual(dump.site);
    // A site that has tables is not restored over.
    await expect(callSiteObject(copy, "restore", dump)).rejects.toMatchObject({
      status: 409,
    });
    await callSiteObject(copy, "erase", {});
  });
});

integration("queries and mutations", () => {
  const code = (
    kind: "query" | "mutation",
    name: string,
    args: unknown,
    member: string | null = null,
  ) =>
    callSiteObject<{ result: unknown }>(site, "call", {
      ownerId,
      site,
      member,
      ...(member === null ? { visitor: true } : {}),
      kind,
      file: "board",
      name,
      args,
    }).then((answer) => answer.result);

  test("anyone may call them, their code decides, and a query cannot write", async () => {
    await put(
      "queries",
      "board",
      `export async function recent(ctx, { board }) {
         return (await ctx.sql\`SELECT id, title FROM posts WHERE board = \${board} ORDER BY id\`).rows;
       }
       export async function whoami(ctx) { return { member: ctx.member, visitor: ctx.visitor }; }
       export async function sneak(ctx) { await ctx.sql\`DELETE FROM posts\`; }`,
      false,
    );
    await put(
      "mutations",
      "board",
      `export async function write(ctx, { title }) {
         if (!ctx.member) ctx.fail("AUTH_REQUIRED", "회원만 글을 쓸 수 있어요.");
         const { rows } = await ctx.sql\`INSERT INTO posts (title, board, author) VALUES (\${title}, 'free', \${ctx.member.id}) RETURNING id\`;
         return rows[0].id;
       }`,
    );
    expect(await code("query", "whoami", null)).toEqual({
      member: null,
      visitor: true,
    });
    await expect(
      code("mutation", "write", { title: "몰래" }),
    ).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    });
    expect(await code("mutation", "write", { title: "넷째" }, "member-2")).toBe(
      4,
    );
    expect(await code("query", "recent", { board: "free" })).toEqual([
      { id: 1, title: "첫 글" },
      { id: 2, title: "둘째" },
      { id: 4, title: "넷째" },
    ]);
    await expect(code("query", "sneak", null)).rejects.toMatchObject({
      message: expect.stringMatching(/read-only query cannot write/),
    });
    // A query or mutation file is not a function, and the other way round.
    await expect(
      callSiteObject(site, "call", {
        ownerId,
        site,
        member: "member-2",
        file: "board",
        name: "recent",
        args: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
    // A visitor's query and mutation at the edge, as browsers reach it.
    await callSiteObject(site, "configure", {
      ownerId,
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
    });
    const atEdge = (path: string, args: unknown) =>
      fetch(`${process.env.EDGE_WORKER_URL}/api/data/v1/${site}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
      });
    const query = await atEdge("_query/board:whoami", null);
    expect(query.status).toBe(200);
    expect(await query.json()).toMatchObject({
      result: { member: null, visitor: true },
    });
    const mutation = await atEdge("_mutate/board:write", { title: "x" });
    expect(mutation.status).toBe(401);
  });
});
