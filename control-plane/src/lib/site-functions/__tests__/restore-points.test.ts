import { expect, test } from "@jest/globals";
import {
  beforeRestoreName,
  restorePointName,
  restorePointOf,
  restorePointsPrefix,
} from "../restore-points";

const generation = "019a2b3c-4d5e-7000-8000-000000000001";

test("restore point names are a release's generation or a restore's time", () => {
  expect(restorePointName(`${generation}.json`)).toBe(true);
  expect(restorePointName(beforeRestoreName(1_790_000_000_000))).toBe(true);
  for (const name of [
    generation,
    `${generation.toUpperCase()}.json`,
    // Not version 7.
    "019a2b3c-4d5e-4000-8000-000000000001.json",
    `../other/restore-points/${generation}.json`,
    `x/${generation}.json`,
    "before-restore-.json",
    "before-restore-12.json.json",
    "routes.json",
    "",
    null,
    42,
  ])
    expect(restorePointName(name)).toBe(false);
});

test("a restore point's name tells when it was made and what it preceded", () => {
  expect(restorePointOf(`${generation}.json`)).toEqual({
    name: `${generation}.json`,
    createdAt: 0x019a2b3c4d5e,
    kind: "release",
    generation,
  });
  expect(restorePointOf("before-restore-1790000000000.json")).toEqual({
    name: "before-restore-1790000000000.json",
    createdAt: 1_790_000_000_000,
    kind: "before-restore",
    generation: null,
  });
  expect(restorePointOf("manifest.json")).toBeNull();
  expect(restorePointsPrefix("alice")).toBe(
    "_naru-runtime/alice/restore-points/",
  );
});
