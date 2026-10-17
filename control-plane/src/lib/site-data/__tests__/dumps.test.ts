/** @jest-environment node */
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "@jest/globals";
import { callSiteObject, siteDataWorker } from "@/lib/edge/client";
import {
  fetchDump,
  readSiteDump,
  restoreSiteDump,
  sendDump,
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
/**
 * About 11 MiB of documents, Korean text included, and random text, so that
 * even gzip-compressed (restore points) they are more than one 5 MiB part.
 */
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
        body: `${"아보카도 ".repeat(50)}${randomBytes(1500).toString("base64")}`,
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

    // Piped from one site's answer into the other's request.
    const worker = siteDataWorker();
    const { rows } = await sendDump(
      worker,
      copy,
      await fetchDump(worker, site),
    );
    expect(rows).toBe(dump.rows);
    const original = (await summarizeDump(worker, site)).tables;
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
    const stream = await fetchDump(siteDataWorker(), site);
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
    const reader = (await fetchDump(siteDataWorker(), site)).getReader();
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
    const before = await summarizeDump(siteDataWorker(), copy);
    for (const [given, message] of [
      // No end line.
      [`${lines.slice(0, -1).join("\n")}\n`, /incomplete/],
      // Cut in the middle of a row.
      [
        dump.text.slice(0, Math.floor(dump.text.length / 2)),
        /not JSON|incomplete/,
      ],
      // The wrong count.
      [`${lines.slice(0, -2).join("\n")}\n${lines.at(-1)}\n`, /says it has/],
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
    expect(await summarizeDump(siteDataWorker(), copy)).toEqual(before);
    expect((await internals(copy)).tables).toEqual([]);

    // Nor does a restore point cut short; nothing of the present is kept.
    const original = await summarizeDump(siteDataWorker(), site);
    const name = "before-restore-1000.ndjson.gz";
    await callSiteObject(site, "putRestorePoint", {
      site,
      name,
      base64: gzipSync(
        Buffer.from(`${lines.slice(0, 100).join("\n")}\n`),
      ).toString("base64"),
    });
    await expect(
      callSiteObject(site, "restoreFrom", { name }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await summarizeDump(siteDataWorker(), site)).toEqual(original);
    expect((await internals(site)).tables).toEqual([]);
  }, 120_000);

  test("a restore point larger than a part is written in parts and read back", async () => {
    const big = await summarizeDump(siteDataWorker(), site);
    // A small restore point, so the one kept of the present is the big one.
    const small = `${"0190f5a0-0000-7000-8000-000000000001"}.ndjson.gz`;
    const smallLines = [
      {
        type: "header",
        version: 2,
        schema: ["CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)"],
      },
      {
        type: "row",
        table: "meta",
        row: { key: "owner_id", value: "someone else" },
      },
      {
        type: "row",
        table: "collections",
        row: {
          id: collectionId,
          name: "old",
          read_access: "public",
          write_access: "owner",
        },
      },
      { type: "row", table: "site:notes", row: { id: 1, body: "옛 글" } },
      { type: "end", rows: 3 },
    ];
    await callSiteObject(site, "putRestorePoint", {
      site,
      name: small,
      base64: gzipSync(
        Buffer.from(
          smallLines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        ),
      ).toString("base64"),
    });
    const restored = await callSiteObject<{ saved: string; rows: number }>(
      site,
      "restoreFrom",
      { name: small },
    );
    expect(restored.saved).toMatch(/^before-restore-\d+\.ndjson\.gz$/);
    const old = await readSiteDump(site);
    expect(old.tables.collections.map((row) => row.name)).toEqual(["old"]);
    expect(old.tables.documents).toEqual([]);
    expect(old.site.tables.notes).toEqual([{ id: 1, body: "옛 글" }]);
    // The owner is the present's, not the restore point's.
    expect(old.tables.meta.find((row) => row.key === "owner_id")?.value).toBe(
      ownerId,
    );

    // What was replaced, more than a part, comes back whole.
    await callSiteObject(site, "restoreFrom", { name: restored.saved });
    const back = await summarizeDump(siteDataWorker(), site);
    expect(back.schema).toEqual(big.schema);
    for (const table of ["collections", "documents", "media_refs"])
      expect(back.tables[table]).toEqual(big.tables[table]);
    expect(back.tables["site:notes"]).toBeUndefined();
    expect((await internals(site)).tables).toEqual([]);
    await callSiteObject(site, "erase", {});
    await callSiteObject(copy, "erase", {});
  }, 180_000);

  test("restore points are gzip NDJSON; a cut-short one changes nothing, and earlier formats are refused", async () => {
    await seed();
    const text = (await readSiteDump(site)).text;
    const original = await summarizeDump(siteDataWorker(), site);
    const gzipped = gzipSync(Buffer.from(text));
    // Cut short: refused, and the site is as it was.
    await callSiteObject(site, "putRestorePoint", {
      site,
      name: "before-restore-2000.ndjson.gz",
      base64: gzipped.subarray(0, gzipped.byteLength - 64).toString("base64"),
    });
    await expect(
      callSiteObject(site, "restoreFrom", {
        name: "before-restore-2000.ndjson.gz",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await summarizeDump(siteDataWorker(), site)).toEqual(original);
    expect((await internals(site)).tables).toEqual([]);
    // Whole, it restores.
    const name = "before-restore-3000.ndjson.gz";
    await callSiteObject(site, "putRestorePoint", {
      site,
      name,
      base64: gzipped.toString("base64"),
    });
    await callSiteObject(site, "restoreFrom", { name });
    const restored = await summarizeDump(siteDataWorker(), site);
    for (const table of ["collections", "documents", "media_refs"])
      expect(restored.tables[table]).toEqual(original.tables[table]);
    // Uncompressed NDJSON and the JSON before it are no restore points.
    for (const old of [
      "before-restore-4000.ndjson",
      "0190f5a0-0000-7000-8000-000000000001.json",
    ])
      await expect(
        callSiteObject(site, "restoreFrom", { name: old }),
      ).rejects.toMatchObject({ status: 400 });
    await callSiteObject(site, "erase", {});
  }, 180_000);
});
