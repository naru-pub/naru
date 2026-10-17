import { describe, expect, test } from "@jest/globals";
import {
  beforeRestoreName,
  compressedRestorePoint,
  legacyRestorePoint,
  pruneRestorePoints,
  RESTORE_POINT_KEEP_MS,
  type RestorePointBucket,
  releaseRestorePointName,
  restorePointName,
  restorePointOf,
  restorePointsPrefix,
} from "../restore-points";

const generation = "019a2b3c-4d5e-7000-8000-000000000001";

test("restore point names are a release's generation or a restore's time, gzip NDJSON, NDJSON or, from before it, JSON", () => {
  for (const name of [
    releaseRestorePointName(generation),
    `${generation}.ndjson.gz`,
    `${generation}.ndjson`,
    `${generation}.json`,
    beforeRestoreName(1_790_000_000_000),
    "before-restore-1790000000000.json",
  ])
    expect(restorePointName(name)).toBe(true);
  expect(beforeRestoreName(1_790_000_000_000)).toBe(
    "before-restore-1790000000000.ndjson.gz",
  );
  expect(releaseRestorePointName(generation)).toBe(`${generation}.ndjson.gz`);
  for (const name of [
    generation,
    `${generation}.txt`,
    `${generation}.jsonl`,
    `${generation.toUpperCase()}.ndjson`,
    // Not version 7.
    "019a2b3c-4d5e-4000-8000-000000000001.ndjson",
    `../other/restore-points/${generation}.ndjson`,
    `x/${generation}.json`,
    "before-restore-.ndjson",
    "before-restore-12.json.ndjson",
    "before-restore-12.ndjson.json",
    "before-restore-12.json.gz",
    `${generation}.gz`,
    `${generation}.ndjson.gz.gz`,
    "routes.json",
    "",
    null,
    42,
  ])
    expect(restorePointName(name)).toBe(false);
  expect(legacyRestorePoint(`${generation}.json`)).toBe(true);
  expect(legacyRestorePoint(`${generation}.ndjson`)).toBe(false);
  expect(legacyRestorePoint(`${generation}.ndjson.gz`)).toBe(false);
  expect(compressedRestorePoint(`${generation}.ndjson.gz`)).toBe(true);
  expect(compressedRestorePoint(`${generation}.ndjson`)).toBe(false);
});

test("a restore point's name tells when it was made and what it preceded", () => {
  for (const extension of ["ndjson.gz", "ndjson", "json"]) {
    expect(restorePointOf(`${generation}.${extension}`)).toEqual({
      name: `${generation}.${extension}`,
      createdAt: 0x019a2b3c4d5e,
      kind: "release",
      generation,
    });
    expect(restorePointOf(`before-restore-1790000000000.${extension}`)).toEqual(
      {
        name: `before-restore-1790000000000.${extension}`,
        createdAt: 1_790_000_000_000,
        kind: "before-restore",
        generation: null,
      },
    );
  }
  expect(restorePointOf("manifest.json")).toBeNull();
  expect(restorePointsPrefix("alice")).toBe(
    "_naru-runtime/alice/restore-points/",
  );
});

describe("keeping restore points a week", () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  /** A UUIDv7 generation made at `ms`. */
  const made = (ms: number, n = 1) =>
    `${ms
      .toString(16)
      .padStart(12, "0")
      .replace(
        /^(.{8})(.{4})$/,
        "$1-$2",
      )}-7000-8000-${String(n).padStart(12, "0")}`;
  function bucket(objects: { key: string; uploaded?: Date }[]) {
    const store = new Map(objects.map((object) => [object.key, object]));
    const deleted: string[][] = [];
    const fake: RestorePointBucket = {
      async list({ prefix, cursor }) {
        const keys = [...store.keys()].filter((key) => key.startsWith(prefix));
        // Two to a page, to cross pages.
        const from = Number(cursor ?? 0);
        const page = keys.slice(from, from + 2);
        return {
          objects: page.map((key) => store.get(key)!),
          truncated: from + 2 < keys.length,
          cursor: String(from + 2),
        };
      },
      async delete(keys) {
        deleted.push(keys);
      },
    };
    return { fake, deleted };
  }
  const prefix = "_naru-runtime/alice/restore-points/";

  test("points six days old stay, eight days old go, and nothing else is touched", async () => {
    const { fake, deleted } = bucket([
      { key: `${prefix}${made(NOW - 6 * DAY)}.ndjson.gz` },
      { key: `${prefix}${made(NOW - 8 * DAY)}.ndjson.gz` },
      { key: `${prefix}${made(NOW - 30 * DAY, 2)}.json` },
      { key: `${prefix}before-restore-${NOW - 6 * DAY}.ndjson.gz` },
      { key: `${prefix}before-restore-${NOW - 8 * DAY}.ndjson` },
      // Outside restore-points/, however old.
      {
        key: "_naru-runtime/alice/revisions/x/manifest.json",
        uploaded: new Date(NOW - 90 * DAY),
      },
      {
        key: "_naru-runtime/alice/restore-points-old/a.json",
        uploaded: new Date(NOW - 90 * DAY),
      },
      { key: `_naru-runtime/bob/restore-points/${made(NOW - 8 * DAY)}.json` },
    ]);
    const removed = await pruneRestorePoints(fake, "alice", NOW);
    expect(removed.sort()).toEqual(
      [
        `${made(NOW - 8 * DAY)}.ndjson.gz`,
        `${made(NOW - 30 * DAY, 2)}.json`,
        `before-restore-${NOW - 8 * DAY}.ndjson`,
      ].sort(),
    );
    expect(deleted.flat().every((key) => key.startsWith(prefix))).toBe(true);
    expect(deleted.flat()).toHaveLength(3);
  });

  test("a name that is not a restore point's is aged by its upload time", async () => {
    const { fake, deleted } = bucket([
      { key: `${prefix}stray.txt`, uploaded: new Date(NOW - 8 * DAY) },
      { key: `${prefix}fresh.txt`, uploaded: new Date(NOW - 6 * DAY) },
      // Its age cannot be told: kept.
      { key: `${prefix}unknown.txt` },
    ]);
    expect(await pruneRestorePoints(fake, "alice", NOW)).toEqual(["stray.txt"]);
    expect(deleted).toEqual([[`${prefix}stray.txt`]]);
  });

  test("a list that strays outside the prefix deletes nothing there, and deletes go in small batches", async () => {
    const keys = Array.from(
      { length: 120 },
      (_, n) => `${prefix}before-restore-${NOW - 8 * DAY - n}.ndjson.gz`,
    );
    const { fake, deleted } = bucket(keys.map((key) => ({ key })));
    const listing = fake.list;
    fake.list = async (options) => {
      const page = await listing(options);
      return {
        ...page,
        objects: [
          ...page.objects,
          { key: "_naru-runtime/alice/manifest.json", uploaded: new Date(0) },
        ],
      };
    };
    expect(await pruneRestorePoints(fake, "alice", NOW)).toHaveLength(120);
    expect(deleted.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(deleted.flat()).not.toContain("_naru-runtime/alice/manifest.json");
    expect(RESTORE_POINT_KEEP_MS).toBe(7 * DAY);
  });
});
