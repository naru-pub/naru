/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { callSiteObject } from "@/lib/edge/client";
import type { OwnerQueryAnswer, TableRowsPage } from "../site-tables-http";

// The owner's read-only view of a site's own tables (1.1.0), end to end in
// the site's Durable Object (scripts/with-edge-worker.sh): `siteTables`
// lists them and `tableRows` pages one, as the control panel's 데이터베이스 →
// 테이블 asks (site-tables-http.ts).
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;

const site = "tablerows";
const ownerId = "0190f5a0-0000-7000-8000-0000000000cd";

const put = (folder: string, file: string, source: string, publish = true) =>
  callSiteObject(site, "putFunctions", { site, folder, file, source, publish });
/** One statement of site SQL, as a mutation of the site's runs it. */
const run = (text: string, values: unknown[] = []) =>
  callSiteObject(site, "call", {
    ownerId,
    site,
    member: null,
    kind: "mutation",
    file: "raw",
    name: "run",
    args: { text, values },
  });
const page = (input: Record<string, unknown>) =>
  callSiteObject<TableRowsPage>(site, "tableRows", input);
const query = (text: string) =>
  callSiteObject<OwnerQueryAnswer>(site, "ownerQuery", { text });

integration("a site's tables on the control panel", () => {
  test("the owner pages a table's rows, and nothing that isn't the site's table", async () => {
    await callSiteObject(site, "erase", {});
    await callSiteObject(site, "configure", {
      ownerId,
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
    });
    await put(
      "migrations",
      "0001_tables",
      `CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT, cover BLOB);
       CREATE VIEW titled AS SELECT title FROM posts;
       CREATE VIRTUAL TABLE search USING fts5(body);`,
      false,
    );
    await put(
      "mutations",
      "raw",
      `export async function run(ctx, { text, values }) { await ctx.sql(text, values); }`,
    );
    for (let id = 1; id <= 150; id++)
      await run("INSERT INTO posts (id, title) VALUES (?, ?)", [
        id,
        `post ${id}`,
      ]);
    await run("UPDATE posts SET cover = zeroblob(2048) WHERE id = 1");

    const tables = await callSiteObject<{ name: string; view: boolean }[]>(
      site,
      "siteTables",
      {},
    );
    expect(tables.map(({ name, view }) => ({ name, view }))).toEqual([
      { name: "posts", view: false },
      { name: "search", view: false },
      { name: "titled", view: true },
    ]);

    const first = await page({ table: "posts" });
    expect(first.columns).toEqual(["id", "title", "cover"]);
    expect(first.rows).toHaveLength(100);
    expect(first.rows[0]).toEqual([1, "post 1", { blob: 2048 }]);
    expect(first.next).toBe(100);
    expect(first.count).toEqual({ rows: 150, more: false });
    const second = await page({ table: "posts", after: first.next });
    expect(second.rows).toHaveLength(50);
    expect(second.rows[0]).toEqual([101, "post 101", null]);
    expect(second.next).toBeNull();
    expect(second).not.toHaveProperty("count");

    for (const table of ["documents", "meta", "search_content", "nothing"])
      await expect(page({ table })).rejects.toMatchObject({ status: 404 });
    await expect(page({ table: "titled" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(page({ table: "posts", limit: 500 })).rejects.toMatchObject({
      status: 400,
    });
  });

  test("the owner's console reads, and changes nothing", async () => {
    expect(
      await query(
        "SELECT p.id, p.title, p.cover, (SELECT count(*) FROM _naru_member_roles) AS roles FROM posts p WHERE p.id <= 2 ORDER BY p.id",
      ),
    ).toEqual({
      columns: ["id", "title", "cover", "roles"],
      rows: [
        [1, "post 1", { blob: 2048 }, 0],
        [2, "post 2", null, 0],
      ],
      more: false,
    });
    const all = await query("SELECT id FROM posts");
    expect(all.rows).toHaveLength(150);
    expect(all.more).toBe(false);
    for (const text of [
      "DELETE FROM posts",
      "UPDATE posts SET title = 'x'",
      "DROP TABLE posts",
      "SELECT * FROM documents",
      "SELECT 1; DELETE FROM posts",
    ])
      await expect(query(text)).rejects.toMatchObject({ status: 400 });
    await expect(query("SELECT nope FROM posts")).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/no such column/),
    });
    expect((await query("SELECT count(*) FROM posts")).rows).toEqual([[150]]);
  });
});
