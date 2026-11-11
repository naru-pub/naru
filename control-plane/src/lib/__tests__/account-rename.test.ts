/** @jest-environment node */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

// Renaming an account against buckets, users and site databases held in
// memory.

type User = {
  id: string;
  login_name: string;
  deleted_at: Date | null;
  site_moderation: string | null;
};
const buckets = new Map<string, Map<string, string>>();
const databases = new Map<string, string[]>();
let users: User[] = [];
const purged: string[] = [];
let failRestore = false;

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
              .map((Key) => ({ Key, Size: 1 })),
          };
        case "CopyObjectCommand": {
          const [, ...path] = (input.CopySource as string).split("/");
          const source = path.map(decodeURIComponent).join("/");
          if (!bucket.has(source)) throw new Error(`no ${source}`);
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
jest.mock("@/lib/database", () => {
  const query = (mode: "select" | "update") => {
    const wheres: [string, string, unknown][] = [];
    let values: Partial<User> = {};
    const matches = (user: User) =>
      wheres.every(([column, op, value]) =>
        op === "is"
          ? (user as any)[column] === value
          : (user as any)[column] === value,
      );
    const chain: any = {
      select: () => chain,
      set: (next: Partial<User>) => ((values = next), chain),
      where: (column: string, op: string, value: unknown) => (
        wheres.push([column, op, value]),
        chain
      ),
      executeTakeFirst: async () => {
        const found = users.filter(matches);
        if (mode === "select") return found[0];
        for (const user of found) Object.assign(user, values);
        return { numUpdatedRows: BigInt(found.length) };
      },
    };
    return chain;
  };
  return {
    db: {
      selectFrom: () => query("select"),
      updateTable: () => query("update"),
    },
  };
});
jest.mock("@/lib/cache-purge", () => ({
  purgeSite: async (login: string) => void purged.push(login),
}));
jest.mock("@/lib/edge/domains", () => ({
  pushEdgeDomainsSoon: async () => {},
}));
jest.mock("@/lib/payments/support", () => ({
  PAYMENT_OPERATOR_USERS: new Set(["operator"]),
}));
jest.mock("@/lib/edge/client", () => ({
  siteDataWorker: () => ({}),
  eraseSiteData: async (site: string) => void databases.delete(site),
}));
jest.mock("@/lib/edge/dumps", () => ({
  fetchDump: async (_target: unknown, site: string) => [
    ...(databases.get(site) ?? []),
  ],
  sendDump: async (_target: unknown, site: string, rows: string[]) => {
    if (failRestore) throw new Error("restore failed");
    if (databases.get(site)?.length) throw new Error("site not empty");
    databases.set(site, rows);
    return { rows: rows.length };
  },
}));

const { renameAccount, RenameError } =
  require("../account-rename") as typeof import("../account-rename");

const keys = (bucket: string) =>
  [...(buckets.get(bucket)?.keys() ?? [])].sort();

beforeEach(() => {
  process.env.S3_BUCKET_NAME = "sites";
  process.env.S3_PRIVATE_BUCKET_NAME = "private";
  buckets.clear();
  databases.clear();
  purged.length = 0;
  failRestore = false;
  users = [
    {
      id: "u1",
      login_name: "oeee-cafe",
      deleted_at: null,
      site_moderation: null,
    },
    {
      id: "u2",
      login_name: "gone",
      deleted_at: new Date(),
      site_moderation: null,
    },
  ];
  buckets.set(
    "sites",
    new Map([
      ["oeee-cafe/index.html", "home"],
      ["oeee-cafe/a b/c.png", "image"],
      ["oeee-cafe-2/index.html", "neighbour"],
      ["_screenshots/oeee-cafe.png", "shot"],
    ]),
  );
  buckets.set(
    "private",
    new Map([["_naru-runtime/oeee-cafe/routes.json", "routes"]]),
  );
  databases.set("oeee-cafe", ["meta", "doc"]);
});

describe("renameAccount", () => {
  test("moves files, runtime and database to the new name", async () => {
    const result = await renameAccount("oeee-cafe", "oekaki");
    expect(result).toEqual({
      from: "oeee-cafe",
      to: "oekaki",
      files: 2,
      runtimeFiles: 1,
      databaseRows: 2,
    });
    expect(users[0].login_name).toBe("oekaki");
    expect(keys("sites")).toEqual([
      "_screenshots/oekaki.png",
      "oeee-cafe-2/index.html",
      "oekaki/a b/c.png",
      "oekaki/index.html",
    ]);
    expect(keys("private")).toEqual(["_naru-runtime/oekaki/routes.json"]);
    expect(databases.get("oekaki")).toEqual(["meta", "doc"]);
    expect(databases.has("oeee-cafe")).toBe(false);
    expect(purged).toEqual(expect.arrayContaining(["oeee-cafe", "oekaki"]));
  });

  test("leaves everything as it was when the database can't be copied", async () => {
    failRestore = true;
    await expect(renameAccount("oeee-cafe", "oekaki")).rejects.toThrow(
      "restore failed",
    );
    expect(users[0].login_name).toBe("oeee-cafe");
    expect(keys("sites")).toEqual([
      "_screenshots/oeee-cafe.png",
      "oeee-cafe-2/index.html",
      "oeee-cafe/a b/c.png",
      "oeee-cafe/index.html",
    ]);
    expect(keys("private")).toEqual(["_naru-runtime/oeee-cafe/routes.json"]);
    expect(databases.get("oeee-cafe")).toEqual(["meta", "doc"]);
  });

  test.each([
    ["Bad Name", "영문 소문자"],
    ["db", "예약된"],
    ["gone", "이미 사용 중"],
    ["oeee-cafe", "같은 아이디"],
  ])("refuses %s", async (to, message) => {
    await expect(renameAccount("oeee-cafe", to)).rejects.toThrow(message);
    expect(users[0].login_name).toBe("oeee-cafe");
  });

  test("refuses a name that already has files", async () => {
    buckets.get("sites")!.set("oekaki/stray.txt", "x");
    await expect(renameAccount("oeee-cafe", "oekaki")).rejects.toThrow(
      RenameError,
    );
    expect(users[0].login_name).toBe("oeee-cafe");
  });

  test("refuses suspended sites and operators", async () => {
    users[0].site_moderation = "suspended";
    await expect(renameAccount("oeee-cafe", "oekaki")).rejects.toThrow(
      "정지된",
    );
    await expect(renameAccount("operator", "other")).rejects.toThrow("운영자");
  });
});
