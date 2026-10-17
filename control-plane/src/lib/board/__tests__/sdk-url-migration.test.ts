/** @jest-environment node */
// The SDK URL rewrite (lib/maintenance/sdk-url-migration.ts) against the
// migrated database the board's tests run on (scripts/test-board.sh): it
// reads users and template snapshots from there, and keeps their sizes.
import { resetLedgerFixtures } from "@/test-support/ledger-fixtures";
import { afterAll, beforeEach, describe, expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { db } from "@/lib/database";
import {
  rewriteStoredSdkUrls,
  type SdkUrlBucket,
  type SdkUrlDeps,
  type StoredFile,
} from "@/lib/maintenance/sdk-url-migration";
import { templateFileKey } from "@/lib/board/preview";

const integration =
  process.env.NARU_BOARD_TEST === "1" ? describe : describe.skip;

const OLD = '<script src="https://naru.pub/sdk/1.1.0/naru.js"></script>\r\n';
const NEW =
  '<script src="https://sdk.naru.pub/sdk/1.1.0/naru.js"></script>\r\n';

// An in-memory bucket with ETags, and a hook to edit a file between its read
// and its write.
let objects: Map<string, StoredFile>;
let version = 0;
let beforePut: ((key: string) => void) | null = null;
function store(
  key: string,
  body: string | Buffer,
  extra: Partial<StoredFile> = {},
) {
  objects.set(key, {
    body: Buffer.from(body),
    etag: `"${++version}"`,
    contentType: "text/html",
    ...extra,
  });
}
const bucket: SdkUrlBucket = {
  async list(prefix) {
    return [...objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, file]) => ({ key, size: file.body.byteLength }));
  },
  async get(key) {
    const file = objects.get(key);
    return file ? { ...file, body: Buffer.from(file.body) } : null;
  },
  async put(key, body, file) {
    beforePut?.(key);
    if (objects.get(key)?.etag !== file.etag) return false;
    objects.set(key, { ...file, body, etag: `"${++version}"` });
    return true;
  },
};
const text = (key: string) => Buffer.from(objects.get(key)!.body).toString();

let purgedSites: [string, string[]][];
let purgedUrls: string[];
const deps: SdkUrlDeps = {
  bucket,
  purgeSiteFiles: async (login, paths) => {
    purgedSites.push([login, [...paths].sort()]);
  },
  purgeUrls: async (urls) => {
    purgedUrls.push(...urls);
  },
};
const quiet = () => {};

integration("rewriteStoredSdkUrls", () => {
  let templateId: string;
  let versionId: string;

  beforeEach(async () => {
    objects = new Map();
    purgedSites = [];
    purgedUrls = [];
    beforePut = null;
    await resetLedgerFixtures(
      db,
      sql`truncate users, board_posts restart identity cascade`,
    );
    const [alice] = await db
      .insertInto("users")
      .values(
        ["alice", "bob"].map((login) => ({
          login_name: login,
          password_hash: "x",
          email: `${login}@example.com`,
          home_directory_size_bytes: 1000,
        })),
      )
      .returning("id")
      .execute();
    const post = await db
      .insertInto("board_posts")
      .values({ user_id: alice.id, kind: "template", title: "t" })
      .returning("id")
      .executeTakeFirstOrThrow();
    templateId = (
      await db
        .insertInto("board_templates")
        .values({
          user_id: alice.id,
          post_id: post.id,
          slug: "t",
          license: "mit",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    versionId = (
      await db
        .insertInto("board_template_versions")
        .values({
          template_id: templateId,
          version: 1,
          source_path: "",
          file_count: 2,
          size_bytes: 500,
          data_collections: "[]",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto("board_template_files")
      .values([
        {
          version_id: versionId,
          path: "index.html",
          content_type: "text/html",
          size_bytes: OLD.length,
        },
        {
          version_id: versionId,
          path: "logo.png",
          content_type: "image/png",
          size_bytes: 4,
        },
      ])
      .execute();

    store("alice/index.html", `﻿${OLD}`, {
      metadata: { sha256: "stale" },
      cacheControl: "no-cache",
    });
    store(
      "alice/js/app.mjs",
      "import '//naru.pub/sdk/1/a.mjs';\nimport 'http://naru.pub/sdk/1/b.mjs';\n",
      {
        contentType: "application/javascript",
      },
    );
    store(
      "alice/plain.txt",
      "https://x.naru.pub/sdk/ and https://naru.pub/sdkfoo",
      {
        contentType: "text/plain",
      },
    );
    store("alice/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      contentType: "image/png",
    });
    store(
      "alice/fake.html",
      Buffer.concat([Buffer.from([0]), Buffer.from(OLD)]),
    );
    store("alice/_naru/routes/page.js", `export default () => '${OLD}'`, {
      contentType: "application/javascript",
    });
    store("bob/index.html", OLD);
    store(templateFileKey(templateId, 1, "index.html"), OLD);
    store(
      templateFileKey(templateId, 1, "logo.png"),
      Buffer.from([1, 2, 3, 4]),
      {
        contentType: "image/png",
      },
    );
  });

  afterAll(async () => {
    await db.destroy();
  });

  test("a dry run reports and changes nothing", async () => {
    const before = new Map(objects);
    const report = await rewriteStoredSdkUrls(
      { apply: false, log: quiet },
      deps,
    );
    expect(objects).toEqual(before);
    expect(purgedSites).toEqual([]);
    expect(purgedUrls).toEqual([]);
    expect(
      Object.fromEntries(
        report.files.map((file) => [file.key, [file.count, file.outcome]]),
      ),
    ).toEqual({
      "alice/index.html": [1, "would-rewrite"],
      "alice/js/app.mjs": [2, "would-rewrite"],
      "alice/_naru/routes/page.js": [1, "reported"],
      "bob/index.html": [1, "would-rewrite"],
      [templateFileKey(templateId, 1, "index.html")]: [1, "would-rewrite"],
    });
    expect(report.bySite.get("alice")).toEqual({ files: 3, matches: 4 });
    expect(
      report.files.find((f) => f.key === "alice/index.html")!.snippets,
    ).toEqual([OLD.trim()]);
    const user = await db
      .selectFrom("users")
      .select("home_directory_size_bytes")
      .where("login_name", "=", "alice")
      .executeTakeFirstOrThrow();
    expect(user.home_directory_size_bytes).toBe(1000);
  });

  test("applying rewrites, keeps headers, purges and counts sizes", async () => {
    const report = await rewriteStoredSdkUrls(
      { apply: true, log: quiet },
      deps,
    );
    expect(report.failed).toEqual([]);

    expect(text("alice/index.html")).toBe(`﻿${NEW}`);
    const index = objects.get("alice/index.html")!;
    expect(index.contentType).toBe("text/html");
    expect(index.cacheControl).toBe("no-cache");
    expect(index.metadata).toEqual({
      sha256: createHash("sha256").update(index.body).digest("hex"),
    });
    expect(text("alice/js/app.mjs")).toBe(
      "import '//sdk.naru.pub/sdk/1/a.mjs';\nimport 'https://sdk.naru.pub/sdk/1/b.mjs';\n",
    );
    expect(objects.get("alice/js/app.mjs")!.contentType).toBe(
      "application/javascript",
    );
    expect(text("alice/_naru/routes/page.js")).toContain(
      "https://naru.pub/sdk/",
    );
    expect(text("alice/plain.txt")).toBe(
      "https://x.naru.pub/sdk/ and https://naru.pub/sdkfoo",
    );
    expect(text("bob/index.html")).toBe(NEW);
    expect(text(templateFileKey(templateId, 1, "index.html"))).toBe(NEW);

    expect(purgedSites).toEqual([
      ["alice", ["index.html", "js/app.mjs"]],
      ["bob", ["index.html"]],
    ]);
    expect(purgedUrls).toEqual([
      `https://r2.${process.env.NEXT_PUBLIC_DOMAIN}/_templates/${templateId}/v1/index.html`,
    ]);

    const sizes = Object.fromEntries(
      (
        await db
          .selectFrom("users")
          .select(["login_name", "home_directory_size_bytes"])
          .execute()
      ).map((user) => [user.login_name, user.home_directory_size_bytes]),
    );
    // +4 for each sdk., +1 more for http → https.
    expect(sizes).toEqual({ alice: 1000 + 4 + 4 + 5, bob: 1004 });
    const file = await db
      .selectFrom("board_template_files")
      .select("size_bytes")
      .where("version_id", "=", versionId)
      .where("path", "=", "index.html")
      .executeTakeFirstOrThrow();
    expect(Number(file.size_bytes)).toBe(NEW.length);
    const templateVersion = await db
      .selectFrom("board_template_versions")
      .select("size_bytes")
      .where("id", "=", versionId)
      .executeTakeFirstOrThrow();
    expect(Number(templateVersion.size_bytes)).toBe(504);

    // Again: nothing left to do.
    purgedSites = [];
    const again = await rewriteStoredSdkUrls({ apply: true, log: quiet }, deps);
    expect(again.files.map((f) => f.outcome)).toEqual(["reported"]);
    expect(purgedSites).toEqual([]);
  });

  test("a file edited after it was read is left alone", async () => {
    beforePut = (key) => {
      if (key === "alice/index.html") store(key, "edited meanwhile");
    };
    const report = await rewriteStoredSdkUrls(
      { apply: true, site: "alice", log: quiet },
      deps,
    );
    expect(text("alice/index.html")).toBe("edited meanwhile");
    expect(
      report.files.find((f) => f.key === "alice/index.html")!.outcome,
    ).toBe("changed");
    expect(purgedSites).toEqual([["alice", ["js/app.mjs"]]]);
    // --site limits it: bob untouched, alice's template included.
    expect(text("bob/index.html")).toBe(OLD);
    expect(text(templateFileKey(templateId, 1, "index.html"))).toBe(NEW);
  });

  test("--site of another user leaves alice's template", async () => {
    await rewriteStoredSdkUrls({ apply: true, site: "bob", log: quiet }, deps);
    expect(text("bob/index.html")).toBe(NEW);
    expect(text("alice/index.html")).toBe(`﻿${OLD}`);
    expect(text(templateFileKey(templateId, 1, "index.html"))).toBe(OLD);
  });
});
