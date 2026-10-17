import { expect, test } from "@jest/globals";
import {
  beforeRestoreName,
  legacyRestorePoint,
  releaseRestorePointName,
  restorePointName,
  restorePointOf,
  restorePointsPrefix,
} from "../restore-points";

const generation = "019a2b3c-4d5e-7000-8000-000000000001";

test("restore point names are a release's generation or a restore's time, NDJSON or, from before it, JSON", () => {
  for (const name of [
    releaseRestorePointName(generation),
    `${generation}.ndjson`,
    `${generation}.json`,
    beforeRestoreName(1_790_000_000_000),
    "before-restore-1790000000000.json",
  ])
    expect(restorePointName(name)).toBe(true);
  expect(beforeRestoreName(1_790_000_000_000)).toBe(
    "before-restore-1790000000000.ndjson",
  );
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
    "routes.json",
    "",
    null,
    42,
  ])
    expect(restorePointName(name)).toBe(false);
  expect(legacyRestorePoint(`${generation}.json`)).toBe(true);
  expect(legacyRestorePoint(`${generation}.ndjson`)).toBe(false);
});

test("a restore point's name tells when it was made and what it preceded", () => {
  for (const extension of ["ndjson", "json"]) {
    expect(restorePointOf(`${generation}.${extension}`)).toEqual({
      name: `${generation}.${extension}`,
      createdAt: 0x019a2b3c4d5e,
      kind: "release",
      generation,
    });
    expect(
      restorePointOf(`before-restore-1790000000000.${extension}`),
    ).toEqual({
      name: `before-restore-1790000000000.${extension}`,
      createdAt: 1_790_000_000_000,
      kind: "before-restore",
      generation: null,
    });
  }
  expect(restorePointOf("manifest.json")).toBeNull();
  expect(restorePointsPrefix("alice")).toBe(
    "_naru-runtime/alice/restore-points/",
  );
});
