/** @jest-environment node */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const send = jest.fn<(command: unknown) => Promise<unknown>>();
jest.mock("@/lib/s3", () => ({ s3Client: { send } }));
jest.mock("@/lib/entitlements", () => ({ userHasFeature: jest.fn() }));
jest.mock("@/lib/database", () => ({ db: { selectFrom: jest.fn() } }));
jest.mock("../service", () => ({
  listCollections: jest.fn(),
  configureCollections: jest.fn(),
}));

const declared =
  require("../declared-collections") as typeof import("../declared-collections");
const service = jest.mocked(
  require("../service") as typeof import("../service"),
);
const entitlements = jest.mocked(
  require("@/lib/entitlements") as typeof import("@/lib/entitlements"),
);
const { db } = jest.mocked(
  require("@/lib/database") as typeof import("@/lib/database"),
);

const owner = { id: "1", loginName: "alice" };
const FILE = JSON.stringify({
  collections: {
    guestbook: { read: "world", write: "create" },
    posts: {
      read: "member",
      write: "admin",
      rules: "board",
      unique: ["slug"],
    },
    settings: { read: "admin", write: "admin" },
  },
});
/** The bucket holds `text` at alice/_naru/collections.json, or nothing. */
function bucket(text: string | null) {
  send.mockImplementation(async () => {
    if (text === null)
      throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    return {
      ContentLength: text.length,
      Body: { transformToString: async () => text },
    };
  });
}
const row = (name: string, read = "admin", write = "admin", extra = {}) => ({
  id: name,
  name,
  read_access: read,
  write_access: write,
  ...extra,
});

beforeEach(() => {
  jest.resetAllMocks();
  service.configureCollections.mockResolvedValue([]);
  entitlements.userHasFeature.mockResolvedValue(true);
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst: async () => ({ id: 1, loginName: "alice" }),
  };
  db.selectFrom.mockReturnValue(chain as never);
});

describe("a site's declared collections", () => {
  test("parse with the sign-in's settings", () => {
    expect(declared.parseDeclaration(FILE)).toEqual({
      guestbook: { read: "world", write: "create" },
      posts: {
        read: "member",
        write: "admin",
        rules: "board",
        unique: ["slug"],
      },
      settings: { read: "admin", write: "admin" },
    });
  });

  test("refuse what is not a declaration", () => {
    for (const text of [
      "{",
      "[]",
      JSON.stringify({ collections: {} }),
      JSON.stringify({ collections: { a: { read: "everyone" } } }),
      JSON.stringify({ collections: { a: { colour: "red" } } }),
      JSON.stringify({ collections: { a: {} } }),
      JSON.stringify({ collections: { a: { read: "world" } } }),
      JSON.stringify({ collections: { a: { write: "admin" } } }),
    ])
      expect(() => declared.parseDeclaration(text)).toThrow();
  });

  test("plan the collections to create apart from changes to existing ones", async () => {
    service.listCollections.mockResolvedValue([
      row("posts", "member", "admin", { rules: "board", unique: ["slug"] }),
      row("settings", "world"),
    ]);
    expect(
      await declared.declaredPlan(owner, declared.parseDeclaration(FILE)),
    ).toEqual({
      create: ["guestbook"],
      configure: [{ name: "settings", changes: { read: ["world", "admin"] } }],
    });
  });

  test("as the file arrives, create what is missing and leave changes for the owner", async () => {
    bucket(FILE);
    service.listCollections.mockResolvedValue([row("settings", "world")]);
    service.configureCollections.mockResolvedValue(["guestbook", "posts"]);
    const result = await declared.installDeclaredCollections("alice");
    expect(service.configureCollections).toHaveBeenCalledWith(owner, [
      { name: "guestbook", read_access: "world", write_access: "create" },
      {
        name: "posts",
        read_access: "member",
        write_access: "admin",
        rules: "board",
        unique: ["slug"],
      },
    ]);
    expect(result).toEqual({
      created: ["guestbook", "posts"],
      pending: [{ name: "settings", changes: { read: ["world", "admin"] } }],
    });
  });

  test("the owner's approval applies the changes too", async () => {
    bucket(FILE);
    service.listCollections.mockResolvedValue([
      row("guestbook", "world", "create"),
      row("posts", "member", "admin", { rules: "board", unique: ["slug"] }),
      row("settings", "world"),
    ]);
    await declared.applyDeclaration(owner);
    expect(service.configureCollections).toHaveBeenCalledWith(owner, [
      { name: "settings", read_access: "admin", write_access: "admin" },
    ]);
  });

  test("sites without the database feature or without a declaration are left alone", async () => {
    bucket(FILE);
    entitlements.userHasFeature.mockResolvedValue(false);
    expect(await declared.installDeclaredCollections("alice")).toBeNull();
    entitlements.userHasFeature.mockResolvedValue(true);
    bucket(null);
    expect(await declared.installDeclaredCollections("alice")).toBeNull();
    expect(service.configureCollections).not.toHaveBeenCalled();
  });
});
