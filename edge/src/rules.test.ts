import { describe, expect, it } from "vitest";
import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { predicate, rulePredicate } from "./rules";
import { SCHEMA, listQuery } from "./query";
import { filters } from "../../control-plane/src/lib/site-data/filters";

describe("rule predicates", () => {
  it("filters secrets before pagination and totals; cursors outlive a changing authorization", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    const insert = db.prepare(
      "INSERT INTO documents VALUES ('c', ?, ?, 1, 1, 1, 1, ?)",
    );
    for (let n = 0; n < 6; n++)
      insert.run(
        String(n),
        JSON.stringify({ board: "a", secret: n < 3 }),
        n === 0 ? "me" : "other",
      );
    const auth = rulePredicate({
      all: [
        { eq: ["board", "a"] },
        {
          any: [
            { ne: ["secret", true] },
            { eq: [{ metadata: "createdBy" }, "me"] },
          ],
        },
      ],
    });
    const q = listQuery("c", { size: 2, includeTotal: true }, auth);
    const rows = db
      .prepare(q.select.sql)
      .all(...(q.select.bindings as SQLInputValue[])) as never[];
    expect(
      db.prepare(q.count!.sql).get(...(q.count!.bindings as SQLInputValue[])),
    ).toMatchObject({
      matched: 4,
    });
    const first = q.page(rows);
    expect(first.documents.map((d) => d.id)).toEqual(["0", "3"]);
    const next = listQuery("c", { size: 2, after: first.nextCursor! }, auth);
    expect(
      next
        .page(
          db
            .prepare(next.select.sql)
            .all(...(next.select.bindings as SQLInputValue[])) as never[],
        )
        .documents.map((d) => d.id),
    ).toEqual(["4", "5"]);
    // The rule's predicate is not the cursor's: one that changes between
    // pages (say, the reader's own items) leaves the cursor valid, and is
    // applied afresh to the next page.
    const changed = listQuery(
      "c",
      { size: 2, after: first.nextCursor! },
      rulePredicate({ ne: ["secret", true] }),
    );
    expect(
      changed
        .page(
          db
            .prepare(changed.select.sql)
            .all(...(changed.select.bindings as SQLInputValue[])) as never[],
        )
        .documents.map((d) => d.id),
    ).toEqual(["4", "5"]);
    // A guarded filter-only cursor binds to the filter alone, as 1.0.0's.
    const guarded = listQuery("c", { size: 2, filter: { board: "a" } }, auth);
    const cursor = guarded.page(
      db
        .prepare(guarded.select.sql)
        .all(...(guarded.select.bindings as SQLInputValue[])) as never[],
    ).nextCursor!;
    expect(
      listQuery("c", { size: 2, filter: { board: "a" }, after: cursor }),
    ).toBeTruthy();
    expect(
      JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString()).f,
    ).toBe(filters({ board: "a" }).fingerprint);
    db.close();
  });
  it("rejects unsafe expressions and distinguishes missing from explicit null", () => {
    for (const expression of [
      null,
      {},
      { sql: "1" },
      { eq: ["bad'field", "x"] },
      { eq: ["x", {}] },
      { any: [] },
      { eq: [{ metadata: "user_id" }, "me"] },
    ])
      expect(() => rulePredicate(expression)).toThrow();
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE documents(data TEXT)");
    db.prepare("INSERT INTO documents VALUES (?)").run("{}");
    const eq = rulePredicate({ eq: ["secret", null] });
    const ne = rulePredicate({ ne: ["secret", true] });
    expect(
      db
        .prepare(`SELECT count(*) AS n FROM documents WHERE ${eq.sql}`)
        .get(...(eq.bindings as SQLInputValue[])),
    ).toMatchObject({ n: 0 });
    expect(
      db
        .prepare(`SELECT count(*) AS n FROM documents WHERE ${ne.sql}`)
        .get(...(ne.bindings as SQLInputValue[])),
    ).toMatchObject({ n: 1 });
    db.close();
  });
  it("where predicates add ranges, in and metadata, and narrow lists and cursors", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    const insert = db.prepare(
      "INSERT INTO documents VALUES ('c', ?, ?, 1, 1, 1, 1, ?)",
    );
    const rows: [string, unknown, string | null][] = [
      ["a", { level: 1, tag: "x" }, "m-1"],
      ["b", { level: 5, tag: "y" }, "m-2"],
      ["c", { level: 9, tag: "z" }, null],
      ["d", { level: "9", tag: "x" }, "m-1"],
      ["e", {}, "m-2"],
    ];
    for (const [id, data, by] of rows) insert.run(id, JSON.stringify(data), by);
    const ids = (where: unknown, size = 50) => {
      const q = listQuery("c", { where, size, includeTotal: true });
      return {
        ids: q
          .page(
            db
              .prepare(q.select.sql)
              .all(...(q.select.bindings as SQLInputValue[])) as never[],
          )
          .documents.map((d) => d.id),
        total: (
          db
            .prepare(q.count!.sql)
            .get(...(q.count!.bindings as SQLInputValue[])) as {
            matched: number;
          }
        ).matched,
      };
    };
    // Ranges match only their own type: "9" is not >= 5.
    expect(ids({ gte: ["level", 5] }).ids).toEqual(["b", "c"]);
    expect(ids({ in: ["tag", ["x", "z"]] }).ids).toEqual(["a", "c", "d"]);
    expect(
      ids({
        any: [{ eq: [{ metadata: "createdBy" }, "m-2"] }, { lt: ["level", 2] }],
      }).ids,
    ).toEqual(["a", "b", "e"]);
    expect(ids({ ne: ["tag", "x"] })).toEqual({
      ids: ["b", "c", "e"],
      total: 3,
    });
    // A cursor belongs to its where: another one starts over.
    const first = listQuery("c", { where: { ne: ["tag", "x"] }, size: 1 });
    const cursor = first.page(
      db
        .prepare(first.select.sql)
        .all(...(first.select.bindings as SQLInputValue[])) as never[],
    ).nextCursor!;
    expect(() =>
      listQuery("c", { where: { eq: ["tag", "x"] }, after: cursor }),
    ).toThrow();
    for (const bad of [
      { gt: ["level", true] },
      { in: ["tag", []] },
      { in: ["tag", Array(101).fill("x")] },
      { like: ["tag", "x"] },
      { eq: [{ metadata: "createdAt" }, "x"] },
    ])
      expect(() => predicate(bad, "where")).toThrow(/^where: /);
    db.close();
  });
});
