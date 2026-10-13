import { expect, test } from "vitest";
import { FunctionRevisions } from "./function-revisions";

function storage() {
  const objects = new Map<string, string>();
  let reads = 0;
  const object = (key: string, value: string) => ({
    key,
    etag: value,
    size: new TextEncoder().encode(value).length,
    text: async () => value,
  });
  const bucket = {
    list: async ({ prefix }: { prefix: string }) => ({
      truncated: false,
      objects: [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => object(key, value)),
    }),
    get: async (key: string) => {
      reads++;
      const value = objects.get(key);
      return value === undefined ? null : object(key, value);
    },
    put: async (key: string, value: string, options?: unknown) => {
      if (!options || !objects.has(key)) objects.set(key, value);
    },
  } as unknown as R2Bucket;
  return { objects, bucket, reads: () => reads };
}

test("revisions pin every dependency and warm immutable sources need no reads", async () => {
  const db = storage();
  db.objects.set(
    "alice/_naru/functions/shop.js",
    'import { price } from "../modules/prices.js"; export function buy() { return price; }',
  );
  db.objects.set("alice/_naru/modules/prices.js", "export const price = 1;");
  const revisions = new FunctionRevisions(db.bucket, "alice");
  const first = await revisions.publish();
  expect(
    (await revisions.graph(first, "functions/shop.js"))["modules/prices.js"],
  ).toContain("1");
  const reads = db.reads();
  await revisions.graph(first, "functions/shop.js");
  expect(db.reads()).toBe(reads);
  db.objects.set("alice/_naru/modules/prices.js", "export const price = 2;");
  const second = await revisions.publish();
  expect(second).not.toBe(first);
  expect(
    (await revisions.graph(first, "functions/shop.js"))["modules/prices.js"],
  ).toContain("1");
  expect(
    (
      await new FunctionRevisions(db.bucket, "alice").graph(
        second,
        "functions/shop.js",
      )
    )["modules/prices.js"],
  ).toContain("2");
});

test("failed publication cannot replace an existing immutable snapshot", async () => {
  const db = storage();
  db.objects.set(
    "alice/_naru/functions/shop.js",
    "export function buy() { return 1; }",
  );
  const revisions = new FunctionRevisions(db.bucket, "alice");
  const first = await revisions.publish();
  db.objects.set(
    "alice/_naru/functions/shop.js",
    'import "../modules/missing.js";',
  );
  await expect(revisions.publish()).rejects.toThrow("Missing import");
  expect(
    (await revisions.graph(first, "functions/shop.js"))["functions/shop.js"],
  ).toContain("return 1");
});

test("cold loads verify source integrity", async () => {
  const db = storage();
  db.objects.set(
    "alice/_naru/functions/shop.js",
    "export function buy() { return 1; }",
  );
  const first = await new FunctionRevisions(db.bucket, "alice").publish();
  const blob = [...db.objects.keys()].find((key) => key.includes("/blobs/"))!;
  db.objects.set(blob, "export function buy() { return 2; }");
  await expect(
    new FunctionRevisions(db.bucket, "alice").graph(first, "functions/shop.js"),
  ).rejects.toThrow("integrity");
});
