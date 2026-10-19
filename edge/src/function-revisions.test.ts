import { expect, test } from "vitest";
import { FunctionRevisions, forgetCachedRevisions } from "./function-revisions";

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
    "alice/_naru/mutations/shop.js",
    'import { price } from "../modules/prices.js"; export function buy() { return price; }',
  );
  db.objects.set("alice/_naru/modules/prices.js", "export const price = 1;");
  const revisions = new FunctionRevisions(db.bucket, db.bucket, "alice");
  const first = await revisions.publish();
  expect(
    (await revisions.graph(first, "mutations/shop.js"))["modules/prices.js"],
  ).toContain("1");
  const reads = db.reads();
  await revisions.graph(first, "mutations/shop.js");
  expect(db.reads()).toBe(reads);
  db.objects.set("alice/_naru/modules/prices.js", "export const price = 2;");
  const second = await revisions.publish();
  expect(second).not.toBe(first);
  expect(
    (await revisions.graph(first, "mutations/shop.js"))["modules/prices.js"],
  ).toContain("1");
  expect(
    (
      await new FunctionRevisions(db.bucket, db.bucket, "alice").graph(
        second,
        "mutations/shop.js",
      )
    )["modules/prices.js"],
  ).toContain("2");
});

test("failed publication cannot replace an existing immutable snapshot", async () => {
  const db = storage();
  db.objects.set(
    "alice/_naru/mutations/shop.js",
    "export function buy() { return 1; }",
  );
  const revisions = new FunctionRevisions(db.bucket, db.bucket, "alice");
  const first = await revisions.publish();
  db.objects.set(
    "alice/_naru/mutations/shop.js",
    'import "../modules/missing.js";',
  );
  await expect(revisions.publish()).rejects.toThrow("Missing import");
  expect(
    (await revisions.graph(first, "mutations/shop.js"))["mutations/shop.js"],
  ).toContain("return 1");
});

test("cold loads verify source integrity", async () => {
  const db = storage();
  db.objects.set(
    "alice/_naru/mutations/shop.js",
    "export function buy() { return 1; }",
  );
  const first = await new FunctionRevisions(
    db.bucket,
    db.bucket,
    "alice",
  ).publish();
  const blob = [...db.objects.keys()].find(
    (key) =>
      key.endsWith("/mutations/shop.js") && key.startsWith("_naru-runtime/"),
  )!;
  db.objects.set(blob, "export function buy() { return 2; }");
  forgetCachedRevisions();
  await expect(
    new FunctionRevisions(db.bucket, db.bucket, "alice").graph(
      first,
      "mutations/shop.js",
    ),
  ).rejects.toThrow("integrity");
});

test("each publication owns all sources, so deleting an old revision preserves reused code", async () => {
  const db = storage();
  const entry =
    'import { price } from "../modules/prices.js"; export function buy() { return price; }';
  db.objects.set("alice/_naru/mutations/shop.js", entry);
  db.objects.set("alice/_naru/modules/prices.js", "export const price = 1;");
  const revisions = new FunctionRevisions(db.bucket, db.bucket, "alice");
  const first = await revisions.publish();
  // An unchanged publish is still a separate, self-contained release.
  const second = await revisions.publish();
  expect(second).not.toBe(first);
  for (const revision of [first, second]) {
    const prefix = `_naru-runtime/alice/revisions/${revision}/`;
    expect(db.objects.get(`${prefix}mutations/shop.js`)).toBe(entry);
    expect(db.objects.get(`${prefix}modules/prices.js`)).toBe(
      "export const price = 1;",
    );
    expect(db.objects.has(`${prefix}manifest.json`)).toBe(true);
  }
  for (const key of db.objects.keys())
    if (key.startsWith(`_naru-runtime/alice/revisions/${first}/`))
      db.objects.delete(key);
  // A fresh loader proves success is independent of any warm source cache.
  forgetCachedRevisions();
  const cold = new FunctionRevisions(db.bucket, db.bucket, "alice");
  expect(
    (await cold.graph(second, "mutations/shop.js"))["modules/prices.js"],
  ).toContain("1");
  await expect(cold.graph(first, "mutations/shop.js")).rejects.toThrow(
    "unavailable",
  );
  expect([...db.objects.keys()].some((key) => key.includes("/blobs/"))).toBe(
    false,
  );
});

test("a failed source upload never writes a completed revision manifest", async () => {
  const db = storage();
  db.objects.set(
    "alice/_naru/mutations/shop.js",
    "export function buy() { return 1; }",
  );
  db.bucket.put = (async () => {
    throw new Error("Storage unavailable");
  }) as R2Bucket["put"];
  await expect(
    new FunctionRevisions(db.bucket, db.bucket, "alice").publish(),
  ).rejects.toThrow("Storage unavailable");
  expect(
    [...db.objects.keys()].some((key) => key.endsWith("/manifest.json")),
  ).toBe(false);
});

test("revisions read sources from the site bucket and keep releases in the private one", async () => {
  const site = storage(),
    runtime = storage();
  site.objects.set(
    "alice/_naru/mutations/shop.js",
    "export function buy() { return 1; }",
  );
  const revision = await new FunctionRevisions(
    site.bucket,
    runtime.bucket,
    "alice",
  ).publish();
  expect(
    [...site.objects.keys()].filter((key) => key.startsWith("_naru-runtime/")),
  ).toEqual([]);
  expect([...runtime.objects.keys()]).toContain(
    `_naru-runtime/alice/revisions/${revision}/manifest.json`,
  );
  forgetCachedRevisions();
  expect(
    await new FunctionRevisions(site.bucket, runtime.bucket, "alice").graph(
      revision,
      "mutations/shop.js",
    ),
  ).toBeTruthy();
});
