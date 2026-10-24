/** @jest-environment node */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { NextRequest } from "next/server";

// The file manager's save, rename and delete routes against a bucket held in memory,
// with the session, the purge and the database standing in.

const bucket = new Map<string, { body: string; etag: string }>();
const purged: string[] = [];
let version = 0;

const put = (key: string, body: string) =>
  bucket.set(key, { body, etag: `"v${++version}"` });

jest.mock("@/lib/s3", () => ({
  s3Client: {
    async send(command: { constructor: { name: string }; input: any }) {
      const { input } = command;
      switch (command.constructor.name) {
        case "HeadObjectCommand": {
          const object = bucket.get(input.Key);
          if (!object)
            throw Object.assign(new Error("NotFound"), { name: "NotFound" });
          return { ETag: object.etag };
        }
        case "PutObjectCommand":
          put(input.Key, input.Body);
          return { ETag: bucket.get(input.Key)!.etag };
        case "ListObjectsV2Command": {
          // Two keys a page, so callers have to follow the pages.
          const keys = [...bucket.keys()]
            .filter((key) => key.startsWith(input.Prefix))
            .sort();
          const from = Number(input.ContinuationToken ?? 0);
          return {
            Contents: keys.slice(from, from + 2).map((Key) => ({ Key })),
            IsTruncated: from + 2 < keys.length,
            NextContinuationToken: String(from + 2),
          };
        }
        case "DeleteObjectsCommand":
          for (const { Key } of input.Delete.Objects) bucket.delete(Key);
          return {};
        case "CopyObjectCommand": {
          const [, ...path] = (input.CopySource as string).split("/");
          const source = decodeURIComponent(path.join("/"));
          bucket.set(input.Key, { ...bucket.get(source)! });
          return {};
        }
        case "DeleteObjectCommand":
          bucket.delete(input.Key);
          return {};
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  },
}));
jest.mock("@/lib/auth", () => ({
  validateRequest: async () => ({
    user: { id: "0199-user", loginName: "alice" },
  }),
}));
jest.mock("@/lib/site-suspension", () => ({
  refuseSuspendedSite: async () => null,
}));
jest.mock("@/lib/cache-purge", () => ({
  purgeSiteFiles: async (login: string, paths: string[]) =>
    void purged.push(...paths.map((path) => `${login}/${path}`)),
  purgeSiteObjects: async (keys: string[]) => void purged.push(...keys),
}));
jest.mock("@/lib/database", () => ({
  db: {
    updateTable: () => ({
      set: () => ({ where: () => ({ execute: async () => {} }) }),
    }),
  },
  recordSiteEdit: async () => {},
}));
jest.mock("next/cache", () => ({ revalidatePath: () => {} }));
jest.mock("@sentry/nextjs", () => ({ captureException: () => {} }));

const save = require("../save/route") as typeof import("../save/route");
const rename = require("../rename/route") as typeof import("../rename/route");
const remove = require("../delete/route") as typeof import("../delete/route");

// jest.setup.js replaces Request, so the routes get what they read of one.
const post = (body: unknown) =>
  ({
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json" }),
    json: async () => body,
  }) as unknown as NextRequest;

beforeEach(() => {
  process.env.S3_BUCKET_NAME = "sites";
  bucket.clear();
  purged.length = 0;
  version = 0;
});

describe("save", () => {
  test("saves over the version the editor loaded and returns the new ETag", async () => {
    put("alice/style.css", "a {}");
    const response = await save.POST(
      post({ filename: "style.css", contents: "b {}", etag: '"v1"' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      etag: '"v2"',
    });
    expect(bucket.get("alice/style.css")!.body).toBe("b {}");
  });

  test("refuses to save over a newer version", async () => {
    put("alice/style.css", "a {}");
    put("alice/style.css", "from MCP");
    const response = await save.POST(
      post({ filename: "style.css", contents: "mine", etag: '"v1"' }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ type: "CONFLICT" });
    expect(bucket.get("alice/style.css")!.body).toBe("from MCP");
  });

  test("refuses to save a file deleted since it was loaded", async () => {
    const response = await save.POST(
      post({ filename: "gone.html", contents: "x", etag: '"v1"' }),
    );
    expect(response.status).toBe(409);
    expect(bucket.has("alice/gone.html")).toBe(false);
  });

  test("saves without checking when no ETag is given", async () => {
    put("alice/style.css", "a {}");
    const response = await save.POST(
      post({ filename: "style.css", contents: "forced" }),
    );
    expect(response.status).toBe(200);
    expect(bucket.get("alice/style.css")!.body).toBe("forced");
  });
});

describe("rename", () => {
  test("changes a file's extension", async () => {
    put("alice/notes.txt", "hi");
    const response = await rename.POST(
      post({ oldFilename: "notes.txt", newFilename: "notes.md" }),
    );
    expect(await response.json()).toMatchObject({
      success: true,
      newPath: "notes.md",
    });
    expect([...bucket.keys()]).toEqual(["alice/notes.md"]);
  });

  test("refuses an extension Naru does not host", async () => {
    put("alice/page.html", "hi");
    const response = await rename.POST(
      post({ oldFilename: "page.html", newFilename: "page.exe" }),
    );
    expect(response.status).toBe(400);
    expect([...bucket.keys()]).toEqual(["alice/page.html"]);
  });

  test("keeps the home page's name", async () => {
    put("alice/index.html", "home");
    const response = await rename.POST(
      post({ oldFilename: "index.html", newFilename: "home.html" }),
    );
    expect(response.status).toBe(400);
    expect([...bucket.keys()]).toEqual(["alice/index.html"]);
  });

  test("renames a folder with everything in it", async () => {
    put("alice/blog/index.html", "blog");
    put("alice/blog/posts/1.html", "one");
    put("alice/blogroll.html", "not inside");
    const response = await rename.POST(
      post({ oldFilename: "blog", newFilename: "journal", isDirectory: true }),
    );
    expect(await response.json()).toMatchObject({
      success: true,
      newPath: "journal",
    });
    expect([...bucket.keys()].sort()).toEqual([
      "alice/blogroll.html",
      "alice/journal/index.html",
      "alice/journal/posts/1.html",
    ]);
    expect(purged.sort()).toEqual([
      "alice/blog/index.html",
      "alice/blog/posts/1.html",
      "alice/journal/index.html",
      "alice/journal/posts/1.html",
    ]);
  });

  test("refuses to rename a folder onto one that exists", async () => {
    put("alice/a/index.html", "a");
    put("alice/b/index.html", "b");
    const response = await rename.POST(
      post({ oldFilename: "a", newFilename: "b", isDirectory: true }),
    );
    expect(response.status).toBe(409);
    expect(bucket.get("alice/b/index.html")!.body).toBe("b");
    expect(bucket.has("alice/a/index.html")).toBe(true);
  });
});

describe("delete", () => {
  beforeEach(() => {
    put("alice/index.html", "home");
    put("alice/blog/index.html", "blog");
    put("alice/blog/posts/1.html", "one");
    put("alice/blog/posts/2.html", "two");
    put("alice/blogroll.html", "beside the folder");
    put("alice/page", "a file with no extension");
    put("alice/page.html.bak", "beside the file");
  });

  const keys = () => [...bucket.keys()].sort();

  test("deletes a file and nothing whose name starts with it", async () => {
    const response = await remove.POST(post({ filename: "page" }));
    expect(await response.json()).toMatchObject({ success: true });
    expect(bucket.has("alice/page")).toBe(false);
    expect(bucket.has("alice/page.html.bak")).toBe(true);
    expect(purged).toEqual(["alice/page"]);
  });

  test("deletes a folder with everything in it, across listing pages", async () => {
    const response = await remove.POST(post({ filename: "blog" }));
    expect(await response.json()).toMatchObject({ success: true });
    expect(keys()).toEqual([
      "alice/blogroll.html",
      "alice/index.html",
      "alice/page",
      "alice/page.html.bak",
    ]);
    expect(purged.sort()).toEqual([
      "alice/blog/index.html",
      "alice/blog/posts/1.html",
      "alice/blog/posts/2.html",
    ]);
  });

  test("takes a folder with its trailing slash", async () => {
    await remove.POST(post({ filename: "blog/posts/" }));
    expect(keys()).toContain("alice/blog/index.html");
    expect(keys()).not.toContain("alice/blog/posts/1.html");
  });

  test("keeps the home page", async () => {
    const response = await remove.POST(post({ filename: "index.html" }));
    expect(response.status).toBe(400);
    expect(bucket.has("alice/index.html")).toBe(true);
  });
});
