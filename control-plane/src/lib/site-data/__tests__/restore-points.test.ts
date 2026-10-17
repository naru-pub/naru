/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { callSiteObject } from "@/lib/edge/client";

// Restore points (1.1.0) end to end in the site's Durable Object
// (scripts/with-edge-worker.sh): a release's migrations keep one, and
// `restoreFrom` returns the site to it, keeping one of what it replaced.
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;

const site = "restoresite";
const other = "restoresite-other";
const ownerId = "0190f5a0-0000-7000-8000-0000000000bb";
const put = (
  target: string,
  folder: string,
  file: string,
  source: string | null,
  publish = true,
) =>
  callSiteObject(target, "putFunctions", {
    site: target,
    folder,
    file,
    source,
    publish,
  });
const call = (kind: "query" | "mutation", name: string, args: unknown = null) =>
  callSiteObject<{ result: unknown }>(site, "call", {
    ownerId,
    site,
    member: null,
    kind,
    file: "notes",
    name,
    args,
  }).then((answer) => answer.result);

type Exported = {
  ownerId: string | null;
  collections: { name: string }[];
  functions?: { revision: string; generation: string | null };
};
const exported = () => callSiteObject<Exported>(site, "export", {});
type Dumped = {
  site: {
    schema: string[];
    tables: Record<string, Record<string, unknown>[]>;
    migrations: { name: string }[];
    roles: { member: string; roles: string }[];
  };
};
const dumped = () => callSiteObject<Dumped>(site, "dump", {});
const restoreFrom = (name: unknown, body: Record<string, unknown> = {}) =>
  callSiteObject<{ revision: string | null; saved: string; rows: number }>(
    site,
    "restoreFrom",
    { ...body, name },
  );

const NOTES = `
export async function list(ctx) {
  return (await ctx.sql\`SELECT body FROM notes ORDER BY id\`).rows.map((row) => row.body);
}
`;
const WRITE = `
export async function add(ctx, { body }) {
  await ctx.sql\`INSERT INTO notes (body) VALUES (\${body})\`;
}
`;

integration("restore points", () => {
  test("a restore returns tables, rows, migrations and roles, and can be undone", async () => {
    await callSiteObject(site, "erase", {});
    await callSiteObject(site, "configure", {
      ownerId,
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
    });
    await put(
      site,
      "migrations",
      "0001_notes",
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
      false,
    );
    await put(site, "mutations", "notes", WRITE, false);
    await put(site, "queries", "notes", NOTES);
    await call("mutation", "add", { body: "하나" });
    await call("mutation", "add", { body: "둘" });
    await callSiteObject(site, "setMemberRoles", {
      member: "member-1",
      roles: ["staff"],
    });
    await callSiteObject(site, "createCollections", {
      ownerId,
      collections: [
        { name: "before", read_access: "public", write_access: "owner" },
      ],
    });

    // The second release's migration keeps a restore point first.
    await put(
      site,
      "migrations",
      "0002_tags",
      "CREATE TABLE tags (name TEXT PRIMARY KEY); INSERT INTO tags VALUES ('a');",
    );
    const release = (await exported()).functions!;
    const point = `${release.generation}.json`;
    await call("mutation", "add", { body: "셋" });
    await callSiteObject(site, "setMemberRoles", {
      member: "member-1",
      roles: [],
    });
    await callSiteObject(site, "setMemberRoles", {
      member: "member-2",
      roles: ["writer"],
    });
    await callSiteObject(site, "createCollections", {
      ownerId,
      collections: [
        { name: "after", read_access: "public", write_access: "owner" },
      ],
    });
    const changed = await dumped();

    // A site named in the body is not the one restored: the URL's is.
    const restored = await restoreFrom(point, { site: other });
    expect(restored.saved).toMatch(/^before-restore-\d+\.json$/);
    // The active release stays.
    expect(restored.revision).toBe(release.revision);
    expect((await exported()).functions).toEqual(release);
    expect((await exported()).ownerId).toBe(ownerId);
    const back = await dumped();
    expect(back.site.schema).toEqual([
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
    ]);
    expect(back.site.migrations.map((row) => row.name)).toEqual([
      "0001_notes.sql",
    ]);
    expect(back.site.roles.map((row) => [row.member, row.roles])).toEqual([
      ["member-1", '["staff"]'],
    ]);
    expect(await call("query", "list")).toEqual(["하나", "둘"]);
    expect((await exported()).collections.map((c) => c.name)).toEqual([
      "before",
    ]);
    // The site still answers visitors: paid status is the present's.
    const visitor = await fetch(
      `${process.env.EDGE_WORKER_URL}/api/data/v1/${site}/_query/notes:list`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: null }),
      },
    );
    expect(visitor.status).toBe(200);

    // Restoring the point kept of the present undoes the restore.
    const undone = await restoreFrom(restored.saved);
    expect(undone.revision).toBe(release.revision);
    expect((await dumped()).site).toEqual(changed.site);
    expect(await call("query", "list")).toEqual(["하나", "둘", "셋"]);
    expect((await exported()).collections.map((c) => c.name).sort()).toEqual([
      "after",
      "before",
    ]);
    // ... and that undo kept its own.
    expect(undone.saved).not.toBe(restored.saved);
    await restoreFrom(undone.saved);
    expect((await dumped()).site.migrations).toHaveLength(1);
  });

  test("a restore point outside the site's own is refused", async () => {
    // Another site's restore point, under its own prefix.
    await callSiteObject(other, "erase", {});
    await put(
      other,
      "migrations",
      "0001_x",
      "CREATE TABLE x (id INTEGER PRIMARY KEY);",
    );
    const theirs = (await callSiteObject<Exported>(other, "export", {}))
      .functions!.generation!;
    await expect(restoreFrom(`${theirs}.json`)).rejects.toMatchObject({
      status: 404,
    });
    for (const name of [
      `../../${other}/restore-points/${theirs}.json`,
      `${theirs}`,
      "routes.json",
      "before-restore-x.json",
      null,
    ])
      await expect(restoreFrom(name)).rejects.toMatchObject({ status: 400 });
    // Nothing changed.
    expect((await dumped()).site.migrations).toHaveLength(1);
    await callSiteObject(other, "erase", {});
  });
});
