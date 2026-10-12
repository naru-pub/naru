import { describe, expect, it } from "vitest";
import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { rulePredicate } from "./rules";
import { SCHEMA, listQuery } from "./query";

describe("rule predicates", () => {
  it("filters secrets before pagination and totals; cursors bind to the authorization", () => {
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
    expect(() =>
      listQuery("c", { after: first.nextCursor! }, rulePredicate(true)),
    ).toThrow();
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
});
