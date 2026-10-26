/** @jest-environment node */
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "@jest/globals";
import { callSiteObject } from "@/lib/edge/client";
import { readSiteDump } from "@/lib/edge/dumps";

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
const dumped = () => readSiteDump(site);
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
  test("a restore returns tables, rows and migrations, and can be undone", async () => {
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
    const point = `${release.generation}.ndjson.gz`;
    await call("mutation", "add", { body: "셋" });
    await callSiteObject(site, "createCollections", {
      ownerId,
      collections: [
        { name: "after", read_access: "public", write_access: "owner" },
      ],
    });
    const changed = await dumped();

    // A site named in the body is not the one restored: the URL's is.
    const restored = await restoreFrom(point, { site: other });
    expect(restored.saved).toMatch(/^before-restore-\d+\.ndjson\.gz$/);
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

  test("writing a restore point deletes the site's points past their week", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const old = `before-restore-${Date.now() - 8 * DAY}.ndjson.gz`;
    const recent = `before-restore-${Date.now() - 6 * DAY}.ndjson.gz`;
    const base64 = gzipSync(Buffer.from((await dumped()).text)).toString(
      "base64",
    );
    for (const name of [old, recent])
      await callSiteObject(site, "putRestorePoint", { site, name, base64 });
    // Restoring the recent one writes a new point, then prunes.
    await restoreFrom(recent);
    await expect(restoreFrom(old)).rejects.toMatchObject({ status: 404 });
    expect((await restoreFrom(recent)).saved).toMatch(/\.ndjson\.gz$/);
  });

  test("the owner keeps a restore point now, one at a time and three an hour", async () => {
    const save = (body: Record<string, unknown> = {}) =>
      callSiteObject<{ name: string; bytes: number }>(
        site,
        "saveRestorePoint",
        body,
      );
    const before = await call("query", "list");
    // A site named in the body is not the one kept: the URL's is.
    const kept = await save({ site: other });
    expect(kept.name).toMatch(/^manual-\d+\.ndjson\.gz$/);
    expect(kept.bytes).toBeGreaterThan(0);
    await call("mutation", "add", { body: "넷" });
    expect(await call("query", "list")).toEqual([
      ...(before as string[]),
      "넷",
    ]);
    // It restores like any other.
    await restoreFrom(kept.name);
    expect(await call("query", "list")).toEqual(before);
    // At once, one is written at a time: a save that meets another being
    // written is refused (409), and three an hour are kept in all (429).
    const outcomes = await Promise.allSettled([save(), save(), save(), save()]);
    let saved = 1 + outcomes.filter((o) => o.status === "fulfilled").length;
    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        expect([409, 429]).toContain(
          (outcome.reason as { status: number }).status,
        );
    while (saved < 3) {
      await save();
      saved++;
    }
    expect(saved).toBe(3);
    // Until the oldest of the hour's is an hour old: nearly the whole hour.
    const refused = await save().then(
      () => null,
      (error) => error,
    );
    expect(refused).toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(refused.retryAfter).toBeGreaterThan(3500);
    expect(refused.retryAfter).toBeLessThanOrEqual(3600);
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
    await expect(restoreFrom(`${theirs}.ndjson.gz`)).rejects.toMatchObject({
      status: 404,
    });
    for (const name of [
      `../../${other}/restore-points/${theirs}.ndjson`,
      `${theirs}`,
      "routes.json",
      "before-restore-x.ndjson",
      `${theirs}.txt`,
      null,
    ])
      await expect(restoreFrom(name)).rejects.toMatchObject({ status: 400 });
    // Nothing changed.
    expect((await dumped()).site.migrations).toHaveLength(1);
    await callSiteObject(other, "erase", {});
  });
});
