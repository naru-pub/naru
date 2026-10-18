/** @jest-environment node */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

// The quarantine task against buckets held in memory, with the site's state
// and Cloudflare's purges standing in.

const buckets = new Map<string, Map<string, string>>();
const purged: string[] = [];
let state: { site_moderation: string | null; deleted_at: Date | null } = {
  site_moderation: "suspended",
  deleted_at: null,
};

jest.mock("@/lib/s3", () => ({
  s3Client: {
    async send(command: { constructor: { name: string }; input: any }) {
      const { input } = command;
      const bucket = buckets.get(input.Bucket) ?? new Map<string, string>();
      buckets.set(input.Bucket, bucket);
      switch (command.constructor.name) {
        case "ListObjectsV2Command":
          return {
            Contents: [...bucket.keys()]
              .filter((key) => key.startsWith(input.Prefix))
              .sort()
              .slice(0, 2)
              .map((Key) => ({ Key })),
          };
        case "CopyObjectCommand": {
          const [, ...path] = (input.CopySource as string).split("/");
          const source = path.map(decodeURIComponent).join("/");
          bucket.set(input.Key, bucket.get(source)!);
          return {};
        }
        case "DeleteObjectsCommand":
          for (const { Key } of input.Delete.Objects) bucket.delete(Key);
          return {};
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  },
}));
jest.mock("@/lib/cache-purge", () => ({
  purgeUrls: async (urls: string[]) => void purged.push(...urls),
  purgeSite: async (login: string) => void purged.push(`tag:${login}`),
}));
jest.mock("@/lib/database", () => ({
  db: {
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirst: async () => state }),
      }),
    }),
  },
}));

const { runSiteQuarantine, deleteQuarantined } =
  require("../site-quarantine") as typeof import("../site-quarantine");

const ctx = {
  step: async <T>(_name: string, fn: () => Promise<T>) => fn(),
  sleepFor: async () => {},
  heartbeat: async () => {},
} as never;
const quarantine = (direction: "in" | "out") => ({
  userId: "0199-user",
  login: "alice",
  direction,
  actionId: "0199-action",
});
const keys = (bucket: string) => [...(buckets.get(bucket)?.keys() ?? [])].sort();

beforeEach(() => {
  process.env.S3_BUCKET_NAME = "sites";
  process.env.SITE_DATA_MEDIA_BUCKET = "media";
  buckets.clear();
  purged.length = 0;
  state = { site_moderation: "suspended", deleted_at: null };
  buckets.set(
    "sites",
    new Map([
      ["alice/index.html", "home"],
      ["alice/a b/?.png", "odd"],
      ["alice/css/site.css", "css"],
      ["alicex/index.html", "another site"],
      ["_screenshots/alice.png", "shot"],
    ]),
  );
  buckets.set(
    "media",
    new Map([
      ["0199-user/1.png", "upload"],
      ["0199-other/2.png", "someone else's"],
    ]),
  );
});

describe("quarantine", () => {
  test("moves a site's files, screenshot and uploads under _suspended/, and back", async () => {
    await runSiteQuarantine(quarantine("in"), ctx);
    expect(keys("sites")).toEqual([
      "_suspended/_screenshots/alice.png",
      "_suspended/alice/a b/?.png",
      "_suspended/alice/css/site.css",
      "_suspended/alice/index.html",
      "alicex/index.html",
    ]);
    expect(keys("media")).toEqual(["0199-other/2.png", "_suspended/0199-user/1.png"]);
    expect(buckets.get("sites")!.get("_suspended/alice/a b/?.png")).toBe("odd");
    // The served addresses are purged, encoded as the edge redirects to them.
    expect(purged).toEqual(
      expect.arrayContaining([
        "https://r2.test.com/alice/a%20b/%3F.png",
        "https://r2.test.com/_screenshots/alice.png",
        "https://media.naru.pub/0199-user/1.png",
        "tag:alice",
      ]),
    );

    state = { site_moderation: null, deleted_at: null };
    purged.length = 0;
    await runSiteQuarantine(quarantine("out"), ctx);
    expect(keys("sites")).toEqual([
      "_screenshots/alice.png",
      "alice/a b/?.png",
      "alice/css/site.css",
      "alice/index.html",
      "alicex/index.html",
    ]);
    expect(keys("media")).toEqual(["0199-other/2.png", "0199-user/1.png"]);
    // A 404 cached while they were away goes too.
    expect(purged).toContain("https://r2.test.com/alice/index.html");
  });

  test("a lift stops a suspension's move, and a deleted account stops either", async () => {
    state = { site_moderation: null, deleted_at: null };
    await runSiteQuarantine(quarantine("in"), ctx);
    expect(keys("sites")).toContain("alice/index.html");
    state = { site_moderation: "suspended", deleted_at: new Date() };
    await runSiteQuarantine(quarantine("in"), ctx);
    expect(keys("sites")).toContain("alice/index.html");
  });

  test("deleting the account deletes what waits in quarantine", async () => {
    await runSiteQuarantine(quarantine("in"), ctx);
    await deleteQuarantined("alice", "0199-user");
    expect(keys("sites")).toEqual(["alicex/index.html"]);
    expect(keys("media")).toEqual(["0199-other/2.png"]);
  });
});
