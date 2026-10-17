/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { callSiteObject } from "@/lib/edge/client";

// Upload references in a site's own tables (1.1.0), end to end in the site's
// Durable Object (scripts/with-edge-worker.sh): searched when the owner's
// media library asks (`tableMediaReferences`), never recorded on writes.
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;

const site = "tablerefs";
const ownerId = "0190f5a0-0000-7000-8000-0000000000cc";
const upload = (n: number) =>
  `0190f5a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const url = (id: string) => `https://media.naru.pub/${ownerId}/${id}.png`;

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
type Answer = {
  references: Record<string, { table: string; column: string }[]>;
  partial: boolean;
  ms: number;
  chars: number;
};
const references = (ids: string[], extra: Record<string, unknown> = {}) =>
  callSiteObject<Answer>(site, "tableMediaReferences", { ids, ...extra });

integration("upload references in site tables", () => {
  test("an upload named only in a table is referenced until its row goes", async () => {
    await callSiteObject(site, "erase", {});
    await callSiteObject(site, "configure", {
      ownerId,
      entitledUntil: null,
      confirmedUntil: Date.now() + 60_000,
    });
    await put(
      "migrations",
      "0001_tables",
      `CREATE TABLE posts (id INTEGER PRIMARY KEY, body TEXT, meta TEXT, views INTEGER);
       CREATE TABLE images (key TEXT PRIMARY KEY, image_id TEXT) WITHOUT ROWID;
       CREATE TABLE odd (rowid TEXT, value);
       CREATE VIRTUAL TABLE search USING fts5(body);`,
      false,
    );
    await put(
      "mutations",
      "raw",
      `export async function run(ctx, { text, values }) { await ctx.sql(text, values); }`,
    );
    const ids = Array.from({ length: 8 }, (_, n) => upload(n + 1));
    const [html, json, bare, odd, inSearch, unused, blob, upper] = ids;
    await run("INSERT INTO posts (id, body, meta, views) VALUES (?, ?, ?, ?)", [
      1,
      `<p><img src="${url(html)}"></p>`,
      JSON.stringify({ cover: { url: url(json) }, tags: ["a"] }),
      7,
    ]);
    // A bare ID, as SDK 1.1.0 uploads return it, in a table keyed without
    // a rowid; a value in an untyped column named after the rowid.
    await run("INSERT INTO images (key, image_id) VALUES (?, ?)", ["a", bare]);
    await run("INSERT INTO odd (rowid, value) VALUES (?, ?)", ["x", url(odd)]);
    // A full-text table (and its shadow tables) only copies its sources.
    await run("INSERT INTO search (body) VALUES (?)", [url(inSearch)]);
    // Only TEXT is read: the same ID in a BLOB names nothing.
    await run("INSERT INTO posts (id, body) VALUES (?, CAST(? AS BLOB))", [
      2,
      url(blob),
    ]);
    await run("INSERT INTO posts (id, body) VALUES (?, ?)", [
      3,
      url(upper).toUpperCase(),
    ]);

    const found = await references(ids);
    expect(found.partial).toBe(false);
    expect(found.references).toEqual({
      [html]: [{ table: "posts", column: "body" }],
      [json]: [{ table: "posts", column: "meta" }],
      [bare]: [{ table: "images", column: "image_id" }],
      [odd]: [{ table: "odd", column: "value" }],
      [upper]: [{ table: "posts", column: "body" }],
    });
    expect(found.references).not.toHaveProperty(inSearch);
    expect(found.references).not.toHaveProperty(unused);
    expect(found.references).not.toHaveProperty(blob);

    // Nothing is kept: the next look sees the row gone, and the same upload
    // named from a second table shows both.
    await run("DELETE FROM posts WHERE id = 1");
    await run("INSERT INTO images (key, image_id) VALUES (?, ?)", [
      "b",
      `["${html}"]`,
    ]);
    await run("INSERT INTO odd (rowid, value) VALUES (?, ?)", [
      "y",
      `{"image":"${url(bare)}"}`,
    ]);
    const after = await references(ids);
    expect(after.references).toEqual({
      [html]: [{ table: "images", column: "image_id" }],
      [bare]: [
        { table: "images", column: "image_id" },
        { table: "odd", column: "value" },
      ],
      [odd]: [{ table: "odd", column: "value" }],
      [upper]: [{ table: "posts", column: "body" }],
    });
    // Anything not an upload ID is ignored, and nothing asked is nothing.
    expect(
      (await references(["../x", 3 as unknown as string, html])).references,
    ).toEqual({ [html]: [{ table: "images", column: "image_id" }] });
    expect(await references([])).toMatchObject({
      references: {},
      partial: false,
    });
  });

  test("a search past its limit stops and says it is partial", async () => {
    const id = upload(1);
    await run("INSERT INTO posts (id, body) VALUES (?, ?)", [
      10,
      "x".repeat(5000),
    ]);
    const stopped = await references([id], { maxChars: 1000 });
    expect(stopped.partial).toBe(true);
    expect(stopped.chars).toBeLessThan(20_000);
  });
});
