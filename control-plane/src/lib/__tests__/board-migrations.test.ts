/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import {
  isMigration,
  migrationConflicts,
  migrationDigest,
} from "@/lib/board/migrations";

describe("a template's migrations against a site's history", () => {
  const core = "CREATE TABLE posts (id INTEGER PRIMARY KEY);";
  const applied = new Map([["0002_core.sql", migrationDigest(core)]]);

  test("one already run as it is needs nothing, and a later one is fine", () => {
    expect(
      migrationConflicts(applied, new Set(["posts"]), [
        { name: "0002_core.sql", sql: core },
        { name: "0003_tags.sql", sql: "CREATE TABLE tags (id INTEGER);" },
      ]),
    ).toEqual([]);
  });

  test("the same name with other SQL, an earlier name, and a table there already conflict", () => {
    expect(
      migrationConflicts(applied, new Set(["posts", "votes"]), [
        { name: "0002_core.sql", sql: "CREATE TABLE other (id INTEGER);" },
        { name: "0001_first.sql", sql: "CREATE TABLE first (id INTEGER);" },
        {
          name: "0003_votes.sql",
          sql: 'create table if not exists "Votes" (id integer);',
        },
      ]),
    ).toEqual([
      expect.stringContaining("0002_core.sql: 같은 이름"),
      expect.stringContaining(
        "0001_first.sql: 이미 적용된 0002_core.sql보다 앞",
      ),
      expect.stringContaining("Votes 테이블이 이미 있어요"),
    ]);
  });

  test("a site that has run nothing takes any migration", () => {
    expect(
      migrationConflicts(new Map(), new Set(), [
        { name: "0001_core.sql", sql: core },
      ]),
    ).toEqual([]);
  });

  test("migrations are the files under _naru/migrations/", () => {
    expect(isMigration("_naru/migrations/0001_core.sql")).toBe(true);
    expect(isMigration("_naru/queries/posts.js")).toBe(false);
  });
});
