/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { callSiteObject, siteDataWorker } from "@/lib/edge/client";
import {
  copySiteData,
  DumpSummary,
  fetchDump,
  readSiteDump,
  restoreSiteDump,
  summarizeDump,
} from "@/lib/edge/dumps";

// Dumps as NDJSON streams end to end in the site's Durable Object
// (scripts/with-edge-worker.sh): a dump larger than an R2 part, its
// snapshot, restores that refuse a dump cut short, and restore points written
// in parts.
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;

const site = "dumpsite";
const copy = "dumpsite-copy";
const ownerId = "0190f5a0-0000-7000-8000-0000000000cc";
const collectionId = "0190f5a0-0000-7000-8000-00000000c011";
/** About 7 MiB of documents, Korean text included: more than one 5 MiB part. */
const DOCUMENTS = 4000;
const internals = (target: string, input: Record<string, unknown> = {}) =>
  callSiteObject<{
    tables: string[];
    snapshotMs: number;
    failed: string | null;
    temporaryBytes: number;
  }>(target, "internalTables", input);
const put = (id: string, title: string) =>
  callSiteObject(site, "execute", {
    ownerId,
    site,
    access: { admin: true, allowedIds: null, anonymous: false },
    path: ["posts", id],
    method: "PUT",
    body: { data: { title } },
  });

async function seed() {
  await callSiteObject(site, "erase", {});
  await callSiteObject(copy, "erase", {});
  const now = Date.now();
  await callSiteObject(site, "import", {
    ownerId,
    collections: [
      {
        id: collectionId,
        name: "posts",
        read_access: "public",
        write_access: "owner",
      },
    ],
    documents: Array.from({ length: DOCUMENTS }, (_, n) => {
      const data = JSON.stringify({
        title: `글 ${n}`,
        body: `${"아보카도 ".repeat(150)}${"x".repeat(1000)}`,
      });
      return {
        collection_id: collectionId,
        id: `doc-${String(n).padStart(5, "0")}`,
        data,
        size_bytes: Buffer.byteLength(data),
        version: 1,
        created_at: now,
        updated_at: now,
        created_by: null,
      };
    }),
  });
  await callSiteObject(site, "configure", {
    ownerId,
    entitledUntil: null,
    confirmedUntil: Date.now() + 600_000,
  });
}

integration("dumps", () => {
  test("a dump larger than a part streams, restores elsewhere and compares equal", async () => {
    await seed();
    const dump = await readSiteDump(site);
    expect(Buffer.byteLength(dump.text)).toBeGreaterThan(5 * 1024 * 1024);
    expect(dump.tables.documents).toHaveLength(DOCUMENTS);
    const { snapshotMs } = await internals(site);
    // How long the snapshot held the object for this site.
    console.log(
      `[dumps] snapshot of ${(Buffer.byteLength(dump.text) / 1048576).toFixed(1)} MiB took ${snapshotMs} ms`,
    );

    // Piped from one site's answer into the other's request, summarized on
    // the way, as move-site-data does.
    const sent = new DumpSummary();
    const worker = siteDataWorker(site);
    const { rows } = await copySiteData(
      worker,
      worker,
      site,
      "restore",
      (chunk) => sent.push(chunk),
      copy,
    );
    expect(rows).toBe(dump.rows);
    const original = sent.finish();
    expect(original.documents.rows).toBe(DOCUMENTS);
    expect((await summarizeDump(worker, copy)).tables).toEqual(original);
    // A site with data is never restored over.
    await expect(restoreSiteDump(copy, dump.text)).rejects.toMatchObject({
      status: 409,
    });
    // Neither leaves a snapshot or staging table.
    expect((await internals(site)).tables).toEqual([]);
    expect((await internals(copy)).tables).toEqual([]);
  }, 120_000);

  test("a write while a dump streams lands after its snapshot, not in it", async () => {
    const stream = await fetchDump(siteDataWorker(site), site);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    // Whatever of the snapshot is still held is outside the site's quota.
    // (How much the runtime has read ahead of this reader is its own: here
    // it may have read the whole dump already.)
    const during = await internals(site);
    expect(during.tables.every((name) => name.startsWith("_naru_snap_"))).toBe(
      true,
    );
    if (during.tables.length)
      expect(during.temporaryBytes).toBeGreaterThan(5 * 1024 * 1024);
    await put("written-meanwhile", "late");
    const chunks = [first.value!];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text).not.toContain("written-meanwhile");
    expect(JSON.parse(text.trimEnd().split("\n").at(-1)!)).toMatchObject({
      type: "end",
    });
    const after = await readSiteDump(site);
    expect(after.tables.documents.map((row) => row.id)).toContain(
      "written-meanwhile",
    );
    expect((await internals(site)).tables).toEqual([]);
  }, 120_000);

  test("a dump its reader gives up leaves no snapshot behind, nor does a failed upload", async () => {
    const reader = (await fetchDump(siteDataWorker(site), site)).getReader();
    await reader.read();
    await reader.cancel();
    let left: string[] = [];
    for (let tries = 0; tries < 50; tries++) {
      left = (await internals(site)).tables;
      if (!left.length) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    expect(left).toEqual([]);
    expect((await internals(site)).temporaryBytes).toBe(0);
    const failed = await internals(site, { failUpload: true });
    expect(failed.failed).toBe("The bucket refused the dump.");
    expect(failed.tables).toEqual([]);
    // The next dump is whole.
    expect((await readSiteDump(site)).tables.documents.length).toBe(
      DOCUMENTS + 1,
    );
  }, 120_000);

  test("a dump cut short, or not one, changes nothing", async () => {
    const dump = await readSiteDump(site);
    const lines = dump.text.trimEnd().split("\n");
    await callSiteObject(copy, "erase", {});
    const before = await summarizeDump(siteDataWorker(copy), copy);
    for (const [given, message] of [
      // No end line.
      [`${lines.slice(0, -1).join("\n")}\n`, /incomplete/],
      // Cut in the middle of a row.
      [dump.text.slice(0, Math.floor(dump.text.length / 2)), /not JSON|incomplete/],
      // The wrong count.
      [
        `${lines.slice(0, -2).join("\n")}\n${lines.at(-1)}\n`,
        /says it has/,
      ],
      ["{}\n", /header/],
      [
        `${lines[0]}\n{"type":"row","table":"site:_naru_roles","row":{}}\n{"type":"end","rows":1}\n`,
        /not the site's/,
      ],
    ] as const)
      await expect(restoreSiteDump(copy, given)).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(message),
      });
    expect(await summarizeDump(siteDataWorker(copy), copy)).toEqual(before);
    expect((await internals(copy)).tables).toEqual([]);

    // Nor does a restore point cut short; nothing of the present is kept.
    const original = await summarizeDump(siteDataWorker(site), site);
    const name = "before-restore-1000.ndjson";
    await callSiteObject(site, "putRestorePoint", {
      site,
      name,
      source: `${lines.slice(0, 100).join("\n")}\n`,
    });
    await expect(
      callSiteObject(site, "restoreFrom", { name }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await summarizeDump(siteDataWorker(site), site)).toEqual(original);
    expect((await internals(site)).tables).toEqual([]);
  }, 120_000);

  test("a restore point larger than a part is written in parts and read back, and one from before NDJSON restores", async () => {
    const big = await summarizeDump(siteDataWorker(site), site);
    // A restore point as releases wrote them before NDJSON: one JSON object.
    const legacy = `${"0190f5a0-0000-7000-8000-000000000001"}.json`;
    await callSiteObject(site, "putRestorePoint", {
      site,
      name: legacy,
      source: JSON.stringify({
        tables: {
          meta: [{ key: "owner_id", value: "someone else" }],
          collections: [
            {
              id: collectionId,
              name: "old",
              read_access: "public",
              write_access: "owner",
            },
          ],
          documents: [],
          media_refs: [],
          rate_limits: [],
        },
        site: {
          schema: ["CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)"],
          tables: { notes: [{ id: 1, body: "옛 글" }] },
          migrations: [],
          roles: [],
        },
      }),
    });
    const restored = await callSiteObject<{ saved: string; rows: number }>(
      site,
      "restoreFrom",
      { name: legacy },
    );
    expect(restored.saved).toMatch(/^before-restore-\d+\.ndjson$/);
    const old = await readSiteDump(site);
    expect(old.tables.collections.map((row) => row.name)).toEqual(["old"]);
    expect(old.tables.documents).toEqual([]);
    expect(old.site.tables.notes).toEqual([{ id: 1, body: "옛 글" }]);
    // The owner is the present's, not the restore point's.
    expect(
      old.tables.meta.find((row) => row.key === "owner_id")?.value,
    ).toBe(ownerId);

    // What was replaced, more than a part, comes back whole.
    await callSiteObject(site, "restoreFrom", { name: restored.saved });
    const back = await summarizeDump(siteDataWorker(site), site);
    expect(back.schema).toEqual(big.schema);
    for (const table of ["collections", "documents", "media_refs"])
      expect(back.tables[table]).toEqual(big.tables[table]);
    expect(back.tables["site:notes"]).toBeUndefined();
    expect((await internals(site)).tables).toEqual([]);
    await callSiteObject(site, "erase", {});
    await callSiteObject(copy, "erase", {});
  }, 180_000);
});
