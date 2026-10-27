/** @jest-environment node */
import { resetLedgerFixtures } from "@/test-support/ledger-fixtures";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";

// An in-memory bucket stands in for R2: keys to content types, ETags (new
// on every write, kept by a copy, as R2's) and, where a test needs them,
// bodies.
type Stored = {
  size: number;
  contentType: string;
  etag: string;
  body?: Buffer;
};
const bucket = new Map<string, Stored>();
let etags = 0;
jest.mock("../storage", () => ({
  listObjects: jest.fn(async (prefix: string) =>
    [...bucket]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.size, etag: value.etag })),
  ),
  copyObject: jest.fn(
    async (source: string, target: string, contentType?: string) => {
      const object = bucket.get(source);
      if (!object) throw new Error(`no such key: ${source}`);
      bucket.set(target, {
        ...object,
        contentType: contentType ?? object.contentType,
      });
    },
  ),
  putObject: jest.fn(
    async (key: string, body: Uint8Array, contentType: string) => {
      bucket.set(key, {
        size: body.byteLength,
        contentType,
        etag: `"${++etags}"`,
        body: Buffer.from(body),
      });
    },
  ),
  deleteObjects: jest.fn(async (keys: string[]) => {
    for (const key of keys) bucket.delete(key);
  }),
  deletePrefix: jest.fn(async (prefix: string) => {
    for (const key of [...bucket.keys()]) {
      if (key.startsWith(prefix)) bucket.delete(key);
    }
  }),
  getText: jest.fn(async (key: string) => {
    const object = bucket.get(key);
    return object ? (object.body?.toString() ?? "") : null;
  }),
  purgeSiteFiles: jest.fn(async () => {}),
}));
// What a site's database holds, and keeping, emptying and restoring it, are
// the site's object's and the private bucket's: given here.
const mockSiteCode = {
  applied: new Map<string, string>(),
  tables: new Set<string>(),
};
jest.mock("../site-code", () => ({
  ...(jest.requireActual("../site-code") as object),
  appliedMigrations: jest.fn(async () => mockSiteCode.applied),
  siteTableNames: jest.fn(async () => mockSiteCode.tables),
  saveDatabase: jest.fn(async () => "manual-1"),
  eraseDatabase: jest.fn(async () => {}),
  restoreDatabase: jest.fn(async () => {}),
}));
// Hourly limits would trip over this many posts from one person.
jest.mock("../limits", () => ({
  assertUnderHourlyLimit: jest.fn(async () => {}),
}));
jest.mock("@/lib/entitlements", () => ({
  getUserFeatures: jest.fn(async () => new Set(["database"])),
  userHasFeature: jest.fn(async () => true),
}));
// A template's workflow uploads to signed URLs and finalize reads the staged
// files back: both from the in-memory bucket.
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(
    async (_client: unknown, command: { input: { Key: string } }) =>
      `https://upload.test/${command.input.Key}`,
  ),
}));
jest.mock("@/lib/s3", () => ({
  s3Client: {
    send: jest.fn(
      async (command: {
        constructor: { name: string };
        input: { Key?: string; Delete?: { Objects: { Key: string }[] } };
      }) => {
        const name = command.constructor.name;
        if (name === "DeleteObjectsCommand") {
          for (const { Key } of command.input.Delete!.Objects)
            bucket.delete(Key);
          return {};
        }
        const object = bucket.get(command.input.Key!);
        if (!object) {
          throw Object.assign(new Error("NotFound"), { name: "NotFound" });
        }
        const body = object.body ?? Buffer.alloc(object.size);
        if (name === "HeadObjectCommand")
          return { ContentLength: body.byteLength };
        return {
          Body: {
            transformToByteArray: async () => new Uint8Array(body),
            transformToString: async () => body.toString("utf8"),
          },
        };
      },
    ),
  },
}));

// Required after the mocks: this transform does not hoist jest.mock above
// imports.
import type { User } from "@/lib/auth";
const { sql } = require("kysely") as typeof import("kysely");
const { getUserFeatures } = require("@/lib/entitlements") as {
  getUserFeatures: jest.Mock<
    typeof import("@/lib/entitlements").getUserFeatures
  >;
};
const { db } = require("@/lib/database") as typeof import("@/lib/database");
const { BoardError } = require("../errors") as typeof import("../errors");
const { LICENSES } = require("../constants") as typeof import("../constants");
const {
  createPost,
  deletePost,
  getPost,
  listLatestPosts,
  listPosts,
  setPostLike,
} = require("../posts") as typeof import("../posts");
const {
  countUnreadNotifications,
  listNotifications,
  markTemplateNotificationsRead,
  createReply,
  deleteReply,
  listReplies,
  markPostNotificationsRead,
} = require("../replies") as typeof import("../replies");
const {
  listPostsForModeration,
  listRepliesForModeration,
  restorePost,
  restoreReply,
} = require("../moderation") as typeof import("../moderation");
const {
  applyTemplate,
  commonDirectory,
  deleteTemplateObjects,
  filesStillPresent,
  getTemplateForPost,
  planApplication,
  publishTemplatePost,
  publishTemplateVersion,
  removeTemplatePreview,
  setTemplatePreview,
  setTemplateSource,
} = require("../templates") as typeof import("../templates");
const {
  applyUpdate,
  disconnectInstall,
  installCounts,
  listInstalls,
  planUpdate,
  setInstallNotify,
} = require("../updates") as typeof import("../updates");
const { templateDashboard } =
  require("../template-dashboard") as typeof import("../template-dashboard");
const { finalizeTemplateUpload, planTemplateUpload, templateUploadStatus } =
  require("../template-uploads") as typeof import("../template-uploads");
const storageMock = require("../storage") as {
  purgeSiteFiles: jest.Mock<(login: string, paths: string[]) => Promise<void>>;
  copyObject: jest.Mock<
    (source: string, target: string, contentType?: string) => Promise<void>
  >;
};
type ApplyProgress = import("../templates").ApplyProgress;
const siteCodeMock = require("../site-code") as {
  saveDatabase: jest.Mock<(ownerId: string) => Promise<string>>;
  eraseDatabase: jest.Mock<(site: string, ownerId: string) => Promise<void>>;
  restoreDatabase: jest.Mock<(ownerId: string, name: string) => Promise<void>>;
};
const { userHasFeature } = require("@/lib/entitlements") as {
  userHasFeature: jest.Mock<typeof import("@/lib/entitlements").userHasFeature>;
};
const { DataError } =
  require("@/lib/site-data/validation") as typeof import("@/lib/site-data/validation");
// Site databases are Durable Objects: the script starts a local Worker.
const { createCollections, listCollections } =
  require("@/lib/site-data/service") as typeof import("@/lib/site-data/service");
const { eraseSiteData } =
  require("@/lib/edge/client") as typeof import("@/lib/edge/client");

// Runs against a disposable, migrated database (scripts/test-board.sh), never
// the developer's own.
const integration =
  process.env.NARU_BOARD_TEST === "1" ? describe : describe.skip;

async function makeUser(loginName: string, verified = true): Promise<User> {
  const row = await db
    .insertInto("users")
    .values({
      login_name: loginName,
      password_hash: "x",
      email: `${loginName}@example.com`,
      email_verified_at: verified ? new Date() : null,
    })
    .returning(["id", "created_at"])
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    loginName,
    createdAt: row.created_at,
    email: `${loginName}@example.com`,
    emailVerifiedAt: verified ? new Date() : null,
    discoverable: false,
  };
}

function put(key: string, contentType = "text/html", size = 10, body?: string) {
  bucket.set(key, {
    size,
    contentType,
    etag: `"${++etags}"`,
    ...(body === undefined ? {} : { body: Buffer.from(body) }),
  });
}

integration("board", () => {
  let alice: User;
  let bob: User;
  let carol: User;

  beforeAll(async () => {
    await resetLedgerFixtures(
      db,
      sql`truncate users, board_posts restart identity cascade`,
    );
    alice = await makeUser("alice");
    bob = await makeUser("bob");
    carol = await makeUser("carol");
    for (const user of [alice, bob, carol]) await eraseSiteData(user.loginName);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(() => {
    bucket.clear();
  });

  describe("posts", () => {
    test("lists by activity, filters by kind, and hides deleted posts", async () => {
      const first = await createPost(alice, {
        kind: "site",
        title: "첫 글",
        body: "안녕하세요",
      });
      const second = await createPost(bob, {
        kind: "site",
        title: "둘째 글",
        body: "도메인이 안 돼요",
      });
      expect(first).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      await createReply(carol, first, { parentId: null, body: "반가워요" });

      const all = await listPosts({ kind: null, sort: "activity", page: 1 });
      expect(all.posts.map((p) => p.id).slice(0, 2)).toEqual([first, second]);
      expect(all.posts[0].lastReplyLoginName).toBe("carol");

      const sites = await listPosts({ kind: "site", sort: "new", page: 1 });
      expect(sites.posts.map((p) => p.id)).toEqual(
        expect.arrayContaining([first, second]),
      );
      const templates = await listPosts({
        kind: "template",
        sort: "new",
        page: 1,
      });
      expect(templates.posts.map((p) => p.id)).not.toContain(second);

      await deletePost(bob, second);
      expect(await getPost(second, null)).toBeNull();
      const after = await listPosts({ kind: null, sort: "new", page: 1 });
      expect(after.posts.map((p) => p.id)).not.toContain(second);
    });

    test("only the author or an admin deletes a post", async () => {
      const id = await createPost(alice, {
        kind: "site",
        title: "지우지 마세요",
        body: "본문",
      });
      await expect(deletePost(bob, id)).rejects.toMatchObject({ status: 403 });
      const yang = await makeUser("yang");
      await expect(deletePost(yang, id)).resolves.toBeDefined();
    });

    test("likes count once per person", async () => {
      const id = await createPost(alice, {
        kind: "site",
        title: "내 사이트",
        body: "",
      });
      expect(await setPostLike(bob, id, true)).toBe(1);
      expect(await setPostLike(bob, id, true)).toBe(1);
      expect(await setPostLike(carol, id, true)).toBe(2);
      expect(await setPostLike(bob, id, false)).toBe(1);
      expect((await getPost(id, carol))?.likedByViewer).toBe(true);
    });

    test("validates titles", async () => {
      await expect(
        createPost(alice, { kind: "site", title: "  ", body: "x" }),
      ).rejects.toBeInstanceOf(BoardError);
    });
  });

  describe("replies", () => {
    test("returns the tree in display order with depth", async () => {
      const post = await createPost(alice, {
        kind: "site",
        title: "스레드",
        body: "본문",
      });
      const a = await createReply(bob, post, { parentId: null, body: "a" });
      const b = await createReply(carol, post, { parentId: null, body: "b" });
      const a1 = await createReply(alice, post, { parentId: a, body: "a1" });
      const a1x = await createReply(bob, post, { parentId: a1, body: "a1x" });
      const a2 = await createReply(carol, post, { parentId: a, body: "a2" });

      const { replies } = await listReplies(post, null);
      expect(replies.map((r) => [r.body, r.depth])).toEqual([
        ["a", 0],
        ["a1", 1],
        ["a1x", 2],
        ["a2", 1],
        ["b", 0],
      ]);
      expect(replies.find((r) => r.id === a2)?.parentId).toBe(a);

      const subtree = await listReplies(post, null, a1);
      expect(subtree.replies.map((r) => r.id)).toEqual([a1, a1x]);
      expect(b).toBeDefined();
      expect((await getPost(post, null))?.replyCount).toBe(5);
    });

    test("replies past the deepest level join their parent's siblings", async () => {
      const post = await createPost(alice, {
        kind: "site",
        title: "깊은 스레드",
        body: "본문",
      });
      let parent: string | null = null;
      const ids: string[] = [];
      for (let depth = 0; depth < 5; depth++) {
        parent = await createReply(bob, post, {
          parentId: parent,
          body: `d${depth}`,
        });
        ids.push(parent);
      }
      const deeper = await createReply(carol, post, {
        parentId: ids[4],
        body: "too deep",
      });
      const { replies } = await listReplies(post, null);
      const reply = replies.find((r) => r.id === deeper)!;
      expect(reply.depth).toBe(4);
      expect(reply.parentId).toBe(ids[3]);
      // The person answered is still the one notified.
      const unread = await countUnreadNotifications(bob.id);
      expect(unread.from).toContain("carol");
    });

    test("notifies the post author and the parent's author once each", async () => {
      await sql`delete from board_notifications`.execute(db);
      const post = await createPost(alice, {
        kind: "site",
        title: "알림",
        body: "본문",
      });
      const top = await createReply(bob, post, { parentId: null, body: "top" });
      // Carol answers Bob: Bob for the reply, Alice for the post.
      await createReply(carol, post, { parentId: top, body: "answer" });
      // Alice answers her own thread's reply: only Bob.
      await createReply(alice, post, { parentId: top, body: "thanks" });

      expect((await countUnreadNotifications(alice.id)).count).toBe(2);
      expect((await countUnreadNotifications(bob.id)).count).toBe(2);
      expect((await countUnreadNotifications(carol.id)).count).toBe(0);

      await markPostNotificationsRead(alice.id, post);
      expect((await countUnreadNotifications(alice.id)).count).toBe(0);
    });

    test("a deleted reply stays as a placeholder only while it has replies", async () => {
      const post = await createPost(alice, {
        kind: "site",
        title: "답글 지우기",
        body: "본문",
      });
      const parent = await createReply(bob, post, {
        parentId: null,
        body: "p",
      });
      const child = await createReply(carol, post, {
        parentId: parent,
        body: "c",
      });
      const lone = await createReply(carol, post, {
        parentId: null,
        body: "l",
      });
      await deleteReply(bob, parent);
      await deleteReply(carol, lone);
      await expect(deleteReply(bob, child)).rejects.toMatchObject({
        status: 403,
      });

      const { replies } = await listReplies(post, null);
      expect(replies.map((r) => [r.id, r.body])).toEqual([
        [parent, null],
        [child, "c"],
      ]);
      expect((await getPost(post, null))?.replyCount).toBe(1);
    });
  });

  describe("moderation", () => {
    test("admins see deleted posts and replies and can restore them", async () => {
      const yang = await makeUser("yang-mod");
      // isBoardAdmin checks the operator list, so borrow its one name.
      const admin = { ...yang, loginName: "yang" };

      const post = await createPost(alice, {
        kind: "site",
        title: "지울 글",
        body: "본문",
      });
      const reply = await createReply(bob, post, {
        parentId: null,
        body: "지울 답글",
      });
      await deleteReply(admin, reply);
      await deletePost(admin, post);

      const deletedPosts = await listPostsForModeration({
        status: "deleted",
        author: "alice",
        page: 1,
      });
      expect(deletedPosts.posts.map((p) => p.id)).toContain(post);
      const deletedReplies = await listRepliesForModeration({
        status: "deleted",
        author: "bob",
        page: 1,
      });
      expect(deletedReplies.replies.map((r) => r.id)).toContain(reply);

      await expect(restorePost(bob, post)).rejects.toMatchObject({
        status: 403,
      });
      await restorePost(admin, post);
      await restoreReply(admin, reply);
      expect((await getPost(post, null))?.replyCount).toBe(1);
      await expect(restoreReply(admin, reply)).rejects.toMatchObject({
        status: 404,
      });
    });

    test("a deleted template can't be restored", async () => {
      put("alice/tpl/index.html");
      const { postId } = await publishTemplatePost(alice, {
        title: "템플릿",
        body: "",
        slug: "mod-tpl",
        license: "cc0-1.0",
        licenseAccepted: true,
        files: ["tpl/index.html"],
        collections: [],
      });
      await deletePost(alice, postId);
      const admin = { ...alice, loginName: "yang" };
      await expect(restorePost(admin, postId)).rejects.toMatchObject({
        status: 409,
      });
      const listed = await listPostsForModeration({
        status: "deleted",
        author: null,
        page: 1,
      });
      expect(listed.posts.find((p) => p.id === postId)?.restorable).toBe(false);
    });
  });

  describe("templates", () => {
    // Everything under alice/retro/ unless a test checks other files.
    function aliceFiles(prefix = "retro/") {
      return [...bucket.keys()]
        .filter((key) => key.startsWith(`alice/${prefix}`))
        .map((key) => key.slice("alice/".length));
    }

    function publish(overrides: Record<string, unknown> = {}) {
      return publishTemplatePost(alice, {
        title: "레트로 홈",
        body: "설명",
        slug: `retro-${Math.random().toString(36).slice(2, 8)}`,
        license: "cc0-1.0",
        licenseAccepted: true,
        files: aliceFiles(),
        collections: [],
        ...overrides,
      });
    }

    test("requires a known license and explicit consent to it", async () => {
      put("alice/retro/index.html");
      for (const licenseAccepted of [undefined, false, "true", 1]) {
        await expect(publish({ licenseAccepted })).rejects.toMatchObject({
          status: 400,
        });
      }
      for (const license of [undefined, "cc-by-nc-4.0", "MIT", "toString"]) {
        await expect(publish({ license })).rejects.toMatchObject({
          status: 400,
        });
      }
      // Every license the app offers is one the database accepts.
      for (const license of Object.keys(LICENSES)) {
        const { postId } = await publish({ license });
        expect((await getTemplateForPost(postId))?.license).toBe(license);
      }
    });

    test("publishing a version preserves an existing template's license", async () => {
      put("alice/retro/index.html");
      const { postId, templateId } = await publish();
      await db
        .updateTable("board_templates")
        .set({ license: "cc-by-sa-4.0" })
        .where("id", "=", templateId)
        .execute();
      await publishTemplateVersion(alice, templateId, {
        files: aliceFiles(),
        changelog: "업데이트",
        collections: [],
      });
      expect((await getTemplateForPost(postId))?.license).toBe("cc-by-sa-4.0");
    });

    test("publishes a snapshot of only the checked files", async () => {
      put("alice/retro/index.html");
      put("alice/retro/style.css", "text/css");
      put("alice/retro/images/bg.png", "image/png", 100);
      put("alice/retro/drafts/secret.html");
      put("alice/index.html");

      const { postId, templateId } = await publish({
        files: ["retro/index.html", "retro/style.css", "retro/images/bg.png"],
      });
      const template = await getTemplateForPost(postId);
      expect(template?.files.map((f) => f.path)).toEqual([
        "images/bg.png",
        "index.html",
        "style.css",
      ]);
      expect(bucket.has(`_templates/${templateId}/v1/index.html`)).toBe(true);
      expect(bucket.has(`_templates/${templateId}/v1/drafts/secret.html`)).toBe(
        false,
      );
      expect(template?.versions[0].sourcePath).toBe("retro/");

      const latest = await listLatestPosts("template", 6);
      expect(latest[0].id).toBe(postId);
      expect(latest.every((p) => p.kind === "template")).toBe(true);
    });

    test("a template shared from a wrapping folder is rooted inside it", async () => {
      expect(commonDirectory(["a/b/x.html", "a/b/c/y.css"])).toBe("a/b/");
      expect(commonDirectory(["a/x.html", "b/y.html"])).toBe("");
      expect(commonDirectory(["index.html", "a/y.html"])).toBe("");

      // Everything checked is in hello-world/.
      put("alice/hello-world/index.html");
      put("alice/index.html");
      const { postId } = await publish({ files: ["hello-world/index.html"] });
      const template = await getTemplateForPost(postId);
      expect(template?.files.map((f) => f.path)).toEqual(["index.html"]);
      expect(template?.versions[0].sourcePath).toBe("hello-world/");

      // Applying into a new folder named the same puts it one level deep.
      await applyTemplate(bob, template!.versions[0].id, {
        targetPath: "hello-world",
        backup: true,
        createCollections: true,
      });
      expect(bucket.has("bob/hello-world/index.html")).toBe(true);
      expect(bucket.has("bob/hello-world/hello-world/index.html")).toBe(false);
    });

    test("a new version starts from the files still on the site", async () => {
      put("alice/retro/index.html");
      put("alice/retro/app.js", "text/javascript");
      // The folder is renamed after v1: its old paths are gone.
      bucket.delete("alice/retro/app.js");
      put("alice/renamed/app.js", "text/javascript");
      expect(
        await filesStillPresent("alice", "retro/", [
          "retro/index.html",
          "retro/app.js",
        ]),
      ).toEqual(["retro/index.html"]);
    });

    test("refuses unhostable, missing, backup, owner's and escaping paths", async () => {
      put("alice/bad/run.exe", "application/octet-stream");
      put("alice/_owner/style.css", "text/css");
      for (const files of [
        ["bad/run.exe"],
        [],
        ["../bob/index.html"],
        ["missing.html"],
        [".backup/2026/index.html"],
        // The owner's own folder, which no template may hold.
        ["_owner/style.css"],
      ]) {
        await expect(publish({ files })).rejects.toMatchObject({ status: 400 });
      }
      await expect(publish({ licenseAccepted: false })).rejects.toMatchObject({
        status: 400,
      });
    });

    test("filters templates that use the database", async () => {
      put("alice/retro/index.html");
      await createCollections(alice, [
        { name: "guestbook", read_access: "world", write_access: "create" },
      ]);
      const withData = await publish({ collections: ["guestbook"] });
      const plain = await publish();
      // Site code keeps its tables in the database, with no collections.
      put("alice/retro/_naru/queries/posts.js", "text/javascript");
      const withCode = await publish({
        files: ["retro/index.html", "retro/_naru/queries/posts.js"],
      });

      const all = await listPosts({ kind: "template", sort: "new", page: 1 });
      const summary = (postId: string) =>
        all.posts.find((post) => post.id === postId)?.template;
      expect(summary(withData.postId)?.usesDatabase).toBe(true);
      expect(summary(withCode.postId)?.usesDatabase).toBe(true);
      expect(summary(plain.postId)?.usesDatabase).toBe(false);

      const filtered = await listPosts({
        kind: "template",
        sort: "new",
        page: 1,
        usesDatabase: true,
      });
      const ids = filtered.posts.map((post) => post.id);
      expect(ids).toContain(withData.postId);
      expect(ids).toContain(withCode.postId);
      expect(ids).not.toContain(plain.postId);
    });

    test("applies into a folder and backs up what it overwrites", async () => {
      put("alice/retro/index.html");
      put("alice/retro/guestbook.js", "application/javascript");
      await createCollections(alice, [
        { name: "guestbook", read_access: "world", write_access: "create" },
      ]);
      const { postId, templateId } = await publish({
        collections: ["guestbook"],
      });
      const template = await getTemplateForPost(postId);
      const versionId = template!.versions[0].id;

      put("bob/index.html", "text/html", 5);
      put("bob/about.html");

      const plan = await planApplication(bob, versionId, "/");
      expect(plan.targetPath).toBe("");
      expect(plan.files).toEqual([
        { path: "guestbook.js", sizeBytes: 10, action: "create" },
        { path: "index.html", sizeBytes: 10, action: "overwrite" },
      ]);
      expect(plan.collections).toEqual([
        { name: "guestbook", action: "create" },
      ]);

      const result = await applyTemplate(bob, versionId, {
        targetPath: "",
        backup: true,
        createCollections: true,
      });
      expect(result.overwritten).toBe(1);
      expect(result.createdCollections).toEqual(["guestbook"]);
      expect(bucket.get(`bob/${result.backupPath}index.html`)?.size).toBe(5);
      expect(bucket.get("bob/index.html")?.size).toBe(10);
      expect(bucket.has("bob/guestbook.js")).toBe(true);
      expect(bucket.has("bob/about.html")).toBe(true);

      const [collection] = await listCollections(bob, ["guestbook"]);
      expect({
        read_access: collection.read_access,
        write_access: collection.write_access,
      }).toEqual({
        read_access: "world",
        write_access: "create",
      });

      // Applying again counts the person once.
      await applyTemplate(bob, versionId, {
        targetPath: "retro-home",
        backup: true,
        createCollections: true,
      });
      expect(bucket.has("bob/retro-home/index.html")).toBe(true);
      expect((await getTemplateForPost(postId))?.applyCount).toBe(1);

      expect(templateId).toBeDefined();
    });

    test("without the database feature, files apply but collections don't", async () => {
      put("alice/retro/index.html");
      await createCollections(alice, [
        { name: "guestbook", read_access: "world", write_access: "create" },
      ]);
      const { postId } = await publish({ collections: ["guestbook"] });
      const versionId = (await getTemplateForPost(postId))!.versions[0].id;

      getUserFeatures.mockResolvedValue(new Set());
      try {
        const plan = await planApplication(carol, versionId, "unpaid");
        expect(plan.collections).toEqual([
          { name: "guestbook", action: "unavailable" },
        ]);
        const result = await applyTemplate(carol, versionId, {
          targetPath: "unpaid",
          backup: true,
          createCollections: true,
        });
        expect(bucket.has("carol/unpaid/index.html")).toBe(true);
        expect(result.createdCollections).toEqual([]);
        expect(result.skippedCollections).toEqual([]);
        expect(result.unavailableCollections).toEqual(["guestbook"]);
        expect(await listCollections(carol, ["guestbook"])).toEqual([]);
      } finally {
        getUserFeatures.mockResolvedValue(new Set(["database"]));
      }
    });

    test("without a backup, nothing is kept", async () => {
      put("alice/retro/index.html");
      const { postId } = await publish();
      const versionId = (await getTemplateForPost(postId))!.versions[0].id;
      put("carol/index.html", "text/html", 3);
      const result = await applyTemplate(carol, versionId, {
        targetPath: "",
        backup: false,
        createCollections: true,
      });
      expect(result.backupPath).toBeNull();
      expect(bucket.get("carol/index.html")?.size).toBe(10);
      expect(
        [...bucket.keys()].some((key) => key.startsWith("carol/.backup/")),
      ).toBe(false);
    });

    // The site's files, to compare before and after.
    const siteOf = (login: string) =>
      new Map([...bucket].filter(([key]) => key.startsWith(`${login}/`)));
    const real = () => storageMock.copyObject.getMockImplementation()!;

    test("a copy that fails puts the site back, even without a backup", async () => {
      put("alice/retro/index.html");
      put("alice/retro/style.css", "text/css");
      const { postId } = await publish();
      const versionId = (await getTemplateForPost(postId))!.versions[0].id;
      const site = await makeUser(`r${Date.now().toString(36)}`);
      put(`${site.loginName}/index.html`, "text/html", 3);
      const before = siteOf(site.loginName);
      const copy = real();
      storageMock.copyObject.mockImplementation(
        async (source, target, contentType) => {
          if (target === `${site.loginName}/style.css`)
            throw new Error("R2 is down");
          return copy(source, target, contentType);
        },
      );
      try {
        await expect(
          applyTemplate(site, versionId, {
            targetPath: "",
            backup: false,
            createCollections: true,
          }),
        ).rejects.toMatchObject({ status: 422 });
      } finally {
        storageMock.copyObject.mockImplementation(copy);
      }
      expect(siteOf(site.loginName)).toEqual(before);
      expect(await listInstalls(site)).toEqual([]);
    });

    test("applying reports its progress, and refuses a second at once", async () => {
      put("alice/retro/index.html");
      put("alice/retro/style.css", "text/css");
      const { postId } = await publish();
      const versionId = (await getTemplateForPost(postId))!.versions[0].id;
      const site = await makeUser(`p${Date.now().toString(36)}`);
      put(`${site.loginName}/index.html`, "text/html", 3);

      // The first application waits in its first copy (the backup).
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const copy = real();
      storageMock.copyObject.mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return copy(...args);
      });
      const events: ApplyProgress[] = [];
      const input = {
        targetPath: "",
        backup: true,
        createCollections: true,
        onProgress: (progress: ApplyProgress) => events.push(progress),
      };
      const first = applyTemplate(site, versionId, input);
      await inside;
      await expect(applyTemplate(site, versionId, input)).rejects.toMatchObject(
        { status: 409 },
      );
      release();
      const result = await first;

      expect(result.written).toBe(2);
      expect(events[0]).toEqual({ phase: "backup", done: 0, total: 1 });
      expect(events).toContainEqual({ phase: "backup", done: 1, total: 1 });
      expect(events).toContainEqual({ phase: "copy", done: 0, total: 2 });
      expect(events.at(-1)).toEqual({ phase: "copy", done: 2, total: 2 });
      // And once it is done, the site takes another.
      await applyTemplate(site, versionId, { ...input, targetPath: "again" });
    });

    test("new versions snapshot again and keep the old files", async () => {
      put("alice/retro/index.html");
      const { postId, templateId } = await publish();
      put("alice/retro/new.css", "text/css");
      expect(
        await publishTemplateVersion(alice, templateId, {
          files: ["retro/index.html", "retro/new.css"],
          changelog: "CSS 추가",
          collections: [],
        }),
      ).toBe(2);
      await expect(
        publishTemplateVersion(bob, templateId, {
          files: ["retro/index.html"],
          changelog: null,
          collections: [],
        }),
      ).rejects.toMatchObject({ status: 403 });

      const template = await getTemplateForPost(postId);
      expect(template?.versions.map((v) => v.version)).toEqual([2, 1]);
      expect(template?.files.map((f) => f.path)).toEqual([
        "index.html",
        "new.css",
      ]);
      expect(bucket.has(`_templates/${templateId}/v1/index.html`)).toBe(true);
      expect(bucket.has(`_templates/${templateId}/v2/new.css`)).toBe(true);
    });

    test("deleted templates cannot be applied and lose their files", async () => {
      put("alice/retro/index.html");
      const { postId, templateId } = await publish();
      const versionId = (await getTemplateForPost(postId))!.versions[0].id;
      const deleted = await deletePost(alice, postId);
      expect(deleted.templateId).toBe(templateId);
      await deleteTemplateObjects(templateId);
      expect(
        [...bucket.keys()].some((key) =>
          key.startsWith(`_templates/${templateId}/`),
        ),
      ).toBe(false);
      await expect(planApplication(bob, versionId, "")).rejects.toMatchObject({
        status: 404,
      });
    });

    test("refuses to apply into the backup folder or the owner's", async () => {
      put("alice/retro/index.html");
      const { postId } = await publish();
      const versionId = (await getTemplateForPost(postId))!.versions[0].id;
      for (const target of [".backup/x", "_owner", "_owner/x"])
        await expect(
          planApplication(bob, versionId, target),
        ).rejects.toMatchObject({ status: 400 });
      // A folder merely named alike elsewhere is the site's as any other.
      await expect(
        planApplication(bob, versionId, "x/_owner"),
      ).resolves.toMatchObject({ blockers: [] });
    });
  });

  describe("installs and updates", () => {
    let n = 0;
    // A fresh member for each test: a site has one template's site code.
    const member = () => makeUser(`m${Date.now().toString(36)}${++n}`);
    // Files in a person's site, under a folder, as path → size.
    const siteOf = (login: string, folder = "") =>
      Object.fromEntries(
        [...bucket]
          .filter(([key]) => key.startsWith(`${login}/${folder}`))
          .filter(([key]) => !key.startsWith(`${login}/.backup/`))
          .map(([key, value]) => [key.slice(login.length + 1), value.etag]),
      );
    async function template(author: User, folder: string, files: string[]) {
      for (const file of files) put(`${author.loginName}/${folder}${file}`);
      const { postId, templateId } = await publishTemplatePost(author, {
        title: "템플릿",
        body: "설명",
        slug: `t-${Math.random().toString(36).slice(2, 8)}`,
        license: "agpl-3.0-or-later",
        licenseAccepted: true,
        files: files.map((file) => `${folder}${file}`),
        collections: [],
      });
      return { postId, templateId };
    }
    const latestVersion = async (postId: string) =>
      (await getTemplateForPost(postId))!.versions[0];

    test("a template with site code installs at the root, and needs the database", async () => {
      const author = await member();
      const { postId } = await template(author, "app/", [
        "index.html",
        "_naru/queries/posts.js",
        "_naru/migrations/0001_core.sql",
      ]);
      const version = await latestVersion(postId);
      expect(version.siteCode).toBe(true);
      expect(version.newMigrations).toEqual(["_naru/migrations/0001_core.sql"]);

      const site = await member();
      await expect(
        planApplication(site, version.id, "community"),
      ).rejects.toMatchObject({ status: 400 });

      getUserFeatures.mockResolvedValueOnce(new Set());
      const unpaid = await planApplication(site, version.id, "");
      expect(unpaid.blockers).toHaveLength(1);

      const result = await applyTemplate(site, version.id, {
        targetPath: "",
        backup: false,
        createCollections: true,
        notify: false,
      });
      expect(Object.keys(siteOf(site.loginName)).sort()).toEqual([
        "_naru/migrations/0001_core.sql",
        "_naru/queries/posts.js",
        "index.html",
      ]);
      const [install] = await listInstalls(site);
      expect(install).toMatchObject({
        id: result.installId,
        targetPath: "",
        notify: false,
        latest: null,
        version: { siteCode: true },
      });

      // A second template's site code replaces the first's, when asked.
      const other = await template(author, "other/", [
        "index.html",
        "_naru/queries/x.js",
      ]);
      const otherVersion = await latestVersion(other.postId);
      const plan = await planApplication(site, otherVersion.id, "");
      expect(plan.blockers).toEqual([]);
      // index.html the second writes over, so it is not in `remove`; the
      // migration has run, so it stays.
      expect(plan.replaces).toMatchObject({
        installId: result.installId,
        remove: ["_naru/queries/posts.js"],
        keep: [],
        migrations: ["_naru/migrations/0001_core.sql"],
      });
      const replacing = {
        targetPath: "",
        backup: true,
        createCollections: true,
        replace: true,
      };
      await expect(
        applyTemplate(site, otherVersion.id, { ...replacing, replace: false }),
      ).rejects.toMatchObject({ status: 409 });

      // The owner changed the first template's query: it is theirs now.
      put(`${site.loginName}/_naru/queries/posts.js`);
      // If Naru refuses the code, both templates' files go back.
      const before = siteOf(site.loginName);
      storageMock.purgeSiteFiles.mockImplementationOnce(async () => {
        throw new DataError(422, "migration failed", "INVALID_REQUEST");
      });
      await expect(
        applyTemplate(site, otherVersion.id, replacing),
      ).rejects.toMatchObject({ status: 422 });
      expect(siteOf(site.loginName)).toEqual(before);
      expect((await listInstalls(site)).map((i) => i.id)).toEqual([
        result.installId,
      ]);

      const replaced = await applyTemplate(site, otherVersion.id, replacing);
      expect(replaced.replaced).toMatchObject({ removed: 0, kept: 1 });
      expect(Object.keys(siteOf(site.loginName)).sort()).toEqual([
        "_naru/migrations/0001_core.sql",
        "_naru/queries/posts.js",
        "_naru/queries/x.js",
        "index.html",
      ]);
      expect((await listInstalls(site)).map((i) => i.id)).toEqual([
        replaced.installId,
      ]);
    });

    test("migrations that cannot run on the site's database need it reset, kept first", async () => {
      const author = await member();
      const { postId } = await template(author, "m/", [
        "index.html",
        "_naru/migrations/0001_core.sql",
      ]);
      const version = await latestVersion(postId);
      const site = await member();
      // The site ran a 0001_core.sql of its own, with other SQL.
      mockSiteCode.applied = new Map([["0001_core.sql", "another digest"]]);
      try {
        const plan = await planApplication(site, version.id, "");
        expect(plan.migrationConflicts).toEqual([
          expect.stringContaining("0001_core.sql: 같은 이름"),
        ]);
        expect(plan.canResetDatabase).toBe(true);
        const input = { targetPath: "", backup: true, createCollections: true };
        await expect(
          applyTemplate(site, version.id, input),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
          applyTemplate(site, version.id, { ...input, resetDatabase: "nope" }),
        ).rejects.toMatchObject({ status: 400 });
        expect(siteCodeMock.saveDatabase).not.toHaveBeenCalled();

        // Refused after the reset: the database and the files come back.
        put(`${site.loginName}/index.html`, "text/html", 3);
        const before = siteOf(site.loginName);
        storageMock.purgeSiteFiles.mockImplementationOnce(async () => {
          throw new DataError(422, "migration failed", "INVALID_REQUEST");
        });
        await expect(
          applyTemplate(site, version.id, {
            ...input,
            resetDatabase: site.loginName,
          }),
        ).rejects.toMatchObject({
          status: 422,
          message: expect.stringContaining("데이터베이스도 되돌렸어요"),
        });
        expect(siteCodeMock.eraseDatabase).toHaveBeenCalledWith(
          site.loginName,
          site.id,
        );
        expect(siteCodeMock.restoreDatabase).toHaveBeenCalledWith(
          site.id,
          "manual-1",
        );
        expect(siteOf(site.loginName)).toEqual(before);
        expect(await listInstalls(site)).toEqual([]);

        const applied = await applyTemplate(site, version.id, {
          ...input,
          resetDatabase: site.loginName,
        });
        expect(applied.restorePoint).toBe("manual-1");
        expect(siteCodeMock.saveDatabase).toHaveBeenCalledTimes(2);
        expect(siteCodeMock.restoreDatabase).toHaveBeenCalledTimes(1);
      } finally {
        mockSiteCode.applied = new Map();
      }
    });

    test("publishing site code records the tables its migrations make, tried on the edge", async () => {
      const author = await member();
      put(`${author.loginName}/tb/index.html`);
      put(
        `${author.loginName}/tb/_naru/migrations/0001_core.sql`,
        "text/plain",
        10,
        "CREATE TABLE posts (id INTEGER PRIMARY KEY); CREATE TABLE drafts (id INTEGER); DROP TABLE drafts;",
      );
      const { postId } = await publishTemplatePost(author, {
        title: "테이블",
        body: "설명",
        slug: `tb-${Math.random().toString(36).slice(2, 8)}`,
        license: "mit",
        licenseAccepted: true,
        files: ["tb/index.html", "tb/_naru/migrations/0001_core.sql"],
        collections: [],
      });
      const [version] = (await getTemplateForPost(postId))!.versions;
      expect(version.tables).toEqual(["posts"]);
      const stored = await db
        .selectFrom("board_template_versions")
        .select("site_tables")
        .where("id", "=", version.id)
        .executeTakeFirstOrThrow();
      expect(stored.site_tables).toEqual(["posts"]);
    });

    test("disconnecting can remove the template's files, keeping the owner's", async () => {
      const author = await member();
      const { postId } = await template(author, "d/", [
        "index.html",
        "style.css",
        "app.js",
      ]);
      const site = await member();
      const { installId } = await applyTemplate(
        site,
        (await latestVersion(postId)).id,
        { targetPath: "d", backup: true, createCollections: true },
      );
      put(`${site.loginName}/d/style.css`);
      put(`${site.loginName}/d/mine.html`);

      // Refused, everything stays, the install too.
      const before = siteOf(site.loginName);
      storageMock.purgeSiteFiles.mockImplementationOnce(async () => {
        throw new Error("purge failed");
      });
      await expect(
        disconnectInstall(site, installId, { removeFiles: true }),
      ).rejects.toMatchObject({ status: 422 });
      expect(siteOf(site.loginName)).toEqual(before);
      expect(await listInstalls(site)).toHaveLength(1);

      const steps: string[] = [];
      expect(
        await disconnectInstall(site, installId, {
          removeFiles: true,
          onProgress: (p) => steps.push(`${p.phase} ${p.done}/${p.total}`),
        }),
      ).toMatchObject({ removed: 2, kept: 1, migrations: 0 });
      expect(steps).toEqual([
        "backup 0/2",
        "backup 1/2",
        "backup 2/2",
        "remove 0/1",
        "code 0/1",
      ]);
      expect(Object.keys(siteOf(site.loginName, "d/")).sort()).toEqual([
        "d/mine.html",
        "d/style.css",
      ]);
      expect(
        [...bucket.keys()].some(
          (key) =>
            key.startsWith(`${site.loginName}/.backup/`) &&
            key.endsWith("/d/index.html"),
        ),
      ).toBe(true);
      expect(await listInstalls(site)).toEqual([]);
    });

    test("nothing a template does reaches the owner's _owner/ folder", async () => {
      const author = await member();
      const { postId, templateId } = await template(author, "o/", [
        "index.html",
        "app.js",
      ]);
      const site = await member();
      const v1 = await latestVersion(postId);
      const { installId } = await applyTemplate(site, v1.id, {
        targetPath: "",
        backup: true,
        createCollections: true,
      });
      put(`${site.loginName}/_owner/style.css`, "text/css");
      const ownEtag = bucket.get(`${site.loginName}/_owner/style.css`)!.etag;
      // As if an install from before the folder was reserved had written it.
      const install = await db
        .selectFrom("board_template_installs")
        .select("files")
        .where("id", "=", installId)
        .executeTakeFirstOrThrow();
      await db
        .updateTable("board_template_installs")
        .set({
          files: JSON.stringify([
            ...install.files,
            { path: "_owner/style.css", etag: ownEtag },
          ]),
        })
        .where("id", "=", installId)
        .execute();

      // v2 drops app.js: the update deletes it, and leaves _owner/ alone.
      put(`${author.loginName}/o/index.html`);
      await publishTemplateVersion(author, templateId, {
        files: ["o/index.html"],
        changelog: null,
        collections: [],
      });
      const plan = await planUpdate(site, installId);
      expect(plan.files.map((file) => file.path).sort()).toEqual([
        "app.js",
        "index.html",
      ]);
      await applyUpdate(site, installId);
      expect(bucket.get(`${site.loginName}/_owner/style.css`)?.etag).toBe(
        ownEtag,
      );
      // Removing the template's files leaves it too.
      await disconnectInstall(site, installId, { removeFiles: true });
      expect(bucket.get(`${site.loginName}/_owner/style.css`)?.etag).toBe(
        ownEtag,
      );
      expect(bucket.has(`${site.loginName}/index.html`)).toBe(false);

      // A version published before the folder was reserved, with a file
      // there, is neither applied nor updated to.
      const { postId: oldPost, templateId: oldTemplate } = await template(
        author,
        "p/",
        ["index.html"],
      );
      const old = await latestVersion(oldPost);
      const other = await member();
      const { installId: otherInstall } = await applyTemplate(other, old.id, {
        targetPath: "",
        backup: true,
        createCollections: true,
      });
      put(`${author.loginName}/p/index.html`);
      await publishTemplateVersion(author, oldTemplate, {
        files: ["p/index.html"],
        changelog: null,
        collections: [],
      });
      const newer = await latestVersion(oldPost);
      await db
        .insertInto("board_template_files")
        .values({
          version_id: newer.id,
          path: "_owner/x.css",
          content_type: "text/css",
          size_bytes: 1,
          etag: null,
          sha256: null,
        })
        .execute();
      const blocked = await planApplication(await member(), newer.id, "");
      expect(blocked.blockers.join()).toMatch(/_owner\/ 폴더/);
      await expect(planUpdate(other, otherInstall)).rejects.toMatchObject({
        status: 409,
      });
    });

    test("an update changes only the template's files, and backs up the owner's", async () => {
      const author = await member();
      const { postId, templateId } = await template(author, "r/", [
        "index.html",
        "style.css",
        "same.css",
        "old.js",
        "dropped-edited.js",
      ]);
      const site = await member();
      const v1 = await latestVersion(postId);
      const { installId } = await applyTemplate(site, v1.id, {
        targetPath: "t",
        backup: true,
        createCollections: true,
      });
      // The owner edits two of the template's files and adds their own.
      put(`${site.loginName}/t/style.css`);
      put(`${site.loginName}/t/dropped-edited.js`);
      put(`${site.loginName}/t/own.html`);

      // v2 changes index.html, drops two files, adds new.js and own.html.
      put(`${author.loginName}/r/index.html`);
      put(`${author.loginName}/r/new.js`);
      put(`${author.loginName}/r/own.html`);
      await publishTemplateVersion(author, templateId, {
        files: [
          "r/index.html",
          "r/style.css",
          "r/same.css",
          "r/new.js",
          "r/own.html",
        ],
        changelog: "두 번째",
        collections: [],
      });
      const [summary] = await listInstalls(site);
      expect(summary.latest).toMatchObject({
        version: 2,
        changelog: "두 번째",
      });

      const plan = await planUpdate(site, installId);
      expect(
        Object.fromEntries(plan.files.map((f) => [f.path, f.action])),
      ).toEqual({
        "t/index.html": "update",
        "t/style.css": "modified",
        "t/new.js": "create",
        "t/own.html": "overwrite",
        "t/old.js": "delete",
        "t/dropped-edited.js": "keep",
      });
      expect(plan.unchanged).toBe(1);
      expect(plan.changelogs).toEqual([{ version: 2, changelog: "두 번째" }]);

      const ownedBefore = bucket.get(`${site.loginName}/t/own.html`)!.etag;
      const editedBefore = bucket.get(`${site.loginName}/t/style.css`)!.etag;
      const result = await applyUpdate(site, installId);
      expect(result).toMatchObject({ version: 2, deleted: 1, kept: 1 });
      const after = siteOf(site.loginName, "t/");
      expect(Object.keys(after).sort()).toEqual([
        "t/dropped-edited.js",
        "t/index.html",
        "t/new.js",
        "t/own.html",
        "t/same.css",
        "t/style.css",
      ]);
      // What it replaced is in the backup, as it was.
      expect(
        bucket.get(`${site.loginName}/${result.backupPath}t/own.html`)?.etag,
      ).toBe(ownedBefore);
      expect(
        bucket.get(`${site.loginName}/${result.backupPath}t/style.css`)?.etag,
      ).toBe(editedBefore);
      expect((await listInstalls(site))[0]).toMatchObject({
        latest: null,
        version: { id: plan.to.id },
      });
      await expect(planUpdate(site, installId)).rejects.toMatchObject({
        status: 409,
      });
      // Another member cannot see or update it.
      await expect(planUpdate(alice, installId)).rejects.toMatchObject({
        status: 404,
      });
    });

    test("an update Naru refuses puts every file back", async () => {
      const author = await member();
      const { postId, templateId } = await template(author, "c/", [
        "index.html",
        "_naru/queries/a.js",
      ]);
      const site = await member();
      const { installId } = await applyTemplate(
        site,
        (await latestVersion(postId)).id,
        { targetPath: "", backup: true, createCollections: true },
      );
      put(`${author.loginName}/c/_naru/queries/a.js`);
      put(`${author.loginName}/c/_naru/migrations/0002_bad.sql`);
      await publishTemplateVersion(author, templateId, {
        files: [
          "c/index.html",
          "c/_naru/queries/a.js",
          "c/_naru/migrations/0002_bad.sql",
        ],
        changelog: null,
        collections: [],
      });
      const before = siteOf(site.loginName);
      storageMock.purgeSiteFiles.mockImplementationOnce(async () => {
        throw new DataError(422, "migration failed", "INVALID_REQUEST");
      });
      await expect(applyUpdate(site, installId)).rejects.toMatchObject({
        status: 422,
        message: expect.stringMatching(/v1 그대로/),
      });
      expect(siteOf(site.loginName)).toEqual(before);
      expect((await listInstalls(site))[0].latest?.version).toBe(2);

      // A first install Naru refuses is taken back too.
      const fresh = await member();
      put(`${fresh.loginName}/index.html`);
      const original = siteOf(fresh.loginName);
      storageMock.purgeSiteFiles.mockImplementationOnce(async () => {
        throw new DataError(422, "migration failed", "INVALID_REQUEST");
      });
      await expect(
        applyTemplate(fresh, (await latestVersion(postId)).id, {
          targetPath: "",
          backup: false,
          createCollections: true,
        }),
      ).rejects.toMatchObject({ status: 422 });
      expect(siteOf(fresh.loginName)).toEqual(original);
      expect(await listInstalls(fresh)).toEqual([]);
    });

    test("an install's notices can be turned off and on, and nothing updates it by itself", async () => {
      const author = await member();
      const { postId, templateId } = await template(author, "q/", [
        "index.html",
      ]);
      const site = await member();
      const { installId } = await applyTemplate(
        site,
        (await latestVersion(postId)).id,
        { targetPath: "q", backup: true, createCollections: true },
      );
      await expect(
        setInstallNotify(site, installId, "auto"),
      ).rejects.toMatchObject({ status: 400 });
      await publishTemplateVersion(author, templateId, {
        files: ["q/index.html"],
        changelog: null,
        collections: [],
      });
      const [install] = await listInstalls(site);
      // Offered, not applied, and no update is queued.
      expect(install).toMatchObject({
        notify: true,
        version: { version: 1 },
        latest: { version: 2 },
      });
      const queued = await sql`
        select 1 from absurd.t_maintenance
        where task_name = 'template-update-v1' and params->>'installId' = ${installId}`.execute(
        db,
      );
      expect(queued.rows).toEqual([]);

      await setInstallNotify(site, installId, false);
      expect((await listInstalls(site))[0]).toMatchObject({
        notify: false,
        latest: null,
      });
      await setInstallNotify(site, installId, true);
      expect((await listInstalls(site))[0].latest?.version).toBe(2);
    });

    test("a new version notifies the installs told of them, once, and hides from the others", async () => {
      const author = await member();
      const { postId, templateId } = await template(author, "n/", [
        "index.html",
      ]);
      const v1 = (await latestVersion(postId)).id;
      const install = async (notify: boolean) => {
        const site = await member();
        await applyTemplate(site, v1, {
          targetPath: "n",
          backup: true,
          createCollections: true,
          notify,
        });
        return site;
      };
      const told = await install(true);
      // Installed twice, told once.
      await applyTemplate(told, v1, {
        targetPath: "again",
        backup: true,
        createCollections: true,
        notify: true,
      });
      const quiet = await install(false);
      // The author's own install hears nothing of their own version.
      await applyTemplate(author, v1, {
        targetPath: "mine",
        backup: true,
        createCollections: true,
      });
      const publish = () =>
        publishTemplateVersion(author, templateId, {
          files: ["n/index.html"],
          changelog: null,
          collections: [],
        });
      const versionNotices = async (user: User) =>
        (await listNotifications(user.id)).filter(
          (n) => n.reason === "template_version",
        );

      await publish();
      expect(await versionNotices(told)).toMatchObject([
        { version: 2, read: false, fromLoginName: author.loginName, postId },
      ]);
      expect(await countUnreadNotifications(told.id)).toEqual({
        count: 1,
        replies: 0,
        from: [],
        versions: 1,
      });
      for (const other of [quiet, author])
        expect(await versionNotices(other)).toEqual([]);

      // The dashboard is the author's alone.
      expect(await templateDashboard(author.id, postId)).not.toBeNull();
      expect(await templateDashboard(told.id, postId)).toBeNull();

      // A later version replaces the unread notice of the one before.
      await publish();
      expect(await versionNotices(told)).toMatchObject([{ version: 3 }]);

      // The badge counts installs with a version waiting; one told of none has none.
      expect(await installCounts(told.id)).toEqual({
        installed: 2,
        updatable: 2,
      });
      expect(await installCounts(quiet.id)).toEqual({
        installed: 1,
        updatable: 0,
      });
      expect((await listInstalls(quiet))[0].latest).toBeNull();
      expect((await listInstalls(told))[0].latest?.version).toBe(3);

      await markTemplateNotificationsRead(told.id);
      expect(await versionNotices(told)).toMatchObject([{ read: true }]);
      expect((await countUnreadNotifications(told.id)).count).toBe(0);
    });

    test("a GitHub template starts empty and takes versions from its workflow", async () => {
      const author = await member();
      const base = {
        title: "커뮹!",
        body: "커뮤 앱",
        slug: `gh-${Math.random().toString(36).slice(2, 8)}`,
        license: "agpl-3.0-or-later",
        licenseAccepted: true,
        files: [],
        collections: [],
        source: "github",
        githubRepository: "naru-pub/commung",
        githubRef: "main",
      };
      await expect(
        publishTemplatePost(author, { ...base, githubRepository: "nope" }),
      ).rejects.toMatchObject({ status: 400 });
      userHasFeature.mockResolvedValueOnce(false);
      await expect(publishTemplatePost(author, base)).rejects.toMatchObject({
        status: 403,
      });
      const { postId, templateId } = await publishTemplatePost(author, base);
      expect(await getTemplateForPost(postId)).toMatchObject({
        source: "github",
        github: { repository: "naru-pub/commung", ref: "refs/heads/main" },
        versions: [],
      });
      await expect(
        publishTemplateVersion(author, templateId, {
          files: ["x"],
          changelog: null,
          collections: [],
        }),
      ).rejects.toMatchObject({ status: 400 });

      const claims = {
        iss: "https://token.actions.githubusercontent.com",
        aud: "https://naru.pub",
        sub: "repo:naru-pub/commung:ref:refs/heads/main",
        exp: 0,
        repository: "naru-pub/commung",
        repository_id: "42",
        ref: "refs/heads/main",
        sha: "a".repeat(40),
      };
      const file = (path: string, text: string) => ({
        path,
        size: Buffer.byteLength(text),
        sha256: require("node:crypto")
          .createHash("sha256")
          .update(text)
          .digest("hex"),
        text,
      });
      const v1Files = [
        file("index.html", "<title>커뮹</title>"),
        file("_naru/queries/posts.js", "export const list = () => [];"),
      ];
      const upload = async (
        files: typeof v1Files,
        sha: string,
        changelog: string,
      ) => {
        const plan = await planTemplateUpload({
          claims: { ...claims, sha },
          templateId,
          manifest: { files: files.map(({ text: _, ...f }) => f) },
          changelog,
        });
        if ("skipped" in plan) throw new Error(plan.message);
        for (const target of plan.uploads) {
          const key = target.url.slice("https://upload.test/".length);
          const body = Buffer.from(
            files.find((f) => f.path === target.path)!.text,
          );
          bucket.set(key, {
            size: body.byteLength,
            contentType: "application/octet-stream",
            etag: `"${++etags}"`,
            body,
          });
        }
        return plan;
      };

      await expect(
        planTemplateUpload({
          claims: { ...claims, repository: "someone/else" },
          templateId,
          manifest: { files: [] },
        }),
      ).rejects.toThrow();
      const first = await upload(v1Files, "b".repeat(40), "첫 버전");
      expect(first.uploads.map((u) => u.path).sort()).toEqual([
        "_naru/queries/posts.js",
        "index.html",
      ]);
      const published = await finalizeTemplateUpload({
        claims: { ...claims, sha: "b".repeat(40) },
        deploymentId: first.deploymentId,
      });
      expect(published).toMatchObject({ version: 1, functions: null });
      expect(
        await templateUploadStatus({
          claims: { ...claims, sha: "b".repeat(40) },
          deploymentId: first.deploymentId,
        }),
      ).toMatchObject({ status: "finalized" });
      const v1 = await latestVersion(postId);
      expect(v1).toMatchObject({
        version: 1,
        siteCode: true,
        githubSha: "b".repeat(40),
        changelog: "첫 버전",
      });

      // Only the changed file is uploaded; the rest comes from v1.
      const v2Files = [
        v1Files[0],
        file("_naru/queries/posts.js", "export const list = () => [1];"),
      ];
      const second = await upload(v2Files, "c".repeat(40), "두 번째");
      expect(second.uploads.map((u) => u.path)).toEqual([
        "_naru/queries/posts.js",
      ]);
      await finalizeTemplateUpload({
        claims: { ...claims, sha: "c".repeat(40) },
        deploymentId: second.deploymentId,
      });
      expect(bucket.has(`_templates/${templateId}/v2/index.html`)).toBe(true);

      // The same files again make no new version.
      const same = await upload(v2Files, "e".repeat(40), "그대로");
      expect(same.uploads).toEqual([]);
      expect(
        await finalizeTemplateUpload({
          claims: { ...claims, sha: "e".repeat(40) },
          deploymentId: same.deploymentId,
        }),
      ).toMatchObject({ version: 2, unchanged: true });
      expect((await latestVersion(postId)).version).toBe(2);

      // Site code that does not parse is never published.
      const broken = await upload(
        [v1Files[0], file("_naru/queries/posts.js", "export const = ;")],
        "d".repeat(40),
        "깨짐",
      );
      await expect(
        finalizeTemplateUpload({
          claims: { ...claims, sha: "d".repeat(40) },
          deploymentId: broken.deploymentId,
        }),
      ).rejects.toThrow(/posts\.js/);
      expect((await latestVersion(postId)).version).toBe(2);

      // The dashboard shows the workflow's runs, newest first.
      expect(
        (await templateDashboard(author.id, postId))!.runs.map((run) => ({
          sha: run.sha[0],
          outcome: run.outcome,
          version: run.version,
        })),
      ).toEqual([
        { sha: "d", outcome: "failed", version: null },
        { sha: "e", outcome: "unchanged", version: 2 },
        { sha: "c", outcome: "published", version: 2 },
        { sha: "b", outcome: "published", version: 1 },
      ]);

      // Switching to snapshots lets the author publish from their site.
      await setTemplateSource(author, templateId, { source: "site" });
      expect((await getTemplateForPost(postId))?.source).toBe("site");
    });

    test("a workflow finds its template by its owner, repository, branch and folder", async () => {
      const author = await member();
      const claims = {
        iss: "https://token.actions.githubusercontent.com",
        aud: "https://naru.pub",
        sub: "repo:naru-pub/monorepo:ref:refs/heads/main",
        exp: 0,
        repository: "naru-pub/monorepo",
        repository_id: "77",
        ref: "refs/heads/main",
        sha: "f".repeat(40),
      };
      const text = "<title>방명록</title>";
      const manifest = {
        files: [
          {
            path: "index.html",
            size: Buffer.byteLength(text),
            sha256: require("node:crypto")
              .createHash("sha256")
              .update(text)
              .digest("hex"),
          },
        ],
      };
      const plan = (folder: string, owner = author.loginName) =>
        planTemplateUpload({ claims, owner, folder, manifest });

      // Before its post exists the run has nothing to publish, and says so.
      expect(await plan("templates/guestbook")).toMatchObject({
        skipped: true,
        uploads: [],
      });

      const base = {
        title: "방명록",
        body: "",
        license: "mit",
        licenseAccepted: true,
        files: [],
        collections: [],
        source: "github",
        githubRepository: "naru-pub/monorepo",
        githubRef: "main",
      };
      const guestbook = await publishTemplatePost(author, {
        ...base,
        slug: `guestbook-${n}`,
        githubPath: "./templates/guestbook/",
      });
      expect(await getTemplateForPost(guestbook.postId)).toMatchObject({
        github: { path: "templates/guestbook" },
      });
      // One template per folder: another folder of the same branch is fine.
      await publishTemplatePost(author, {
        ...base,
        slug: `links-${n}`,
        githubPath: "templates/links",
      });
      await expect(
        publishTemplatePost(author, {
          ...base,
          slug: `again-${n}`,
          githubPath: "templates/guestbook",
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        publishTemplatePost(author, {
          ...base,
          slug: `escape-${n}`,
          githubPath: "templates/../secret",
        }),
      ).rejects.toMatchObject({ status: 400 });

      // The folder finds it, however it is written.
      const found = await plan("templates/guestbook/");
      expect("skipped" in found).toBe(false);
      // Someone else naming the same repository is not this owner: a
      // workflow names its owner, so another account cannot take its runs.
      const squatter = await member();
      await publishTemplatePost(squatter, {
        ...base,
        slug: `squat-${n}`,
        githubPath: "templates/guestbook",
      });
      const again = await plan("templates/guestbook");
      expect("skipped" in again ? null : again.deploymentId).toBeTruthy();
      expect(
        await db
          .selectFrom("board_template_uploads")
          .select("template_id")
          .where("id", "=", "skipped" in again ? "" : again.deploymentId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ template_id: guestbook.templateId });
    });

    // The smallest files the preview's checks take for each type.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ]);
    const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");
    const sha256 = (bytes: Buffer) =>
      require("node:crypto").createHash("sha256").update(bytes).digest("hex");

    test("an author sets their template's own preview, and can remove it", async () => {
      const author = await member();
      put(`${author.loginName}/app/index.html`);
      const { postId, templateId } = await publishTemplatePost(author, {
        title: "앱",
        body: "",
        slug: `app-${n}`,
        license: "mit",
        licenseAccepted: true,
        files: ["app/index.html"],
        collections: [],
      });
      // Until then, the version's screenshot (none yet).
      expect(await getTemplateForPost(postId)).toMatchObject({
        customPreview: false,
        previewUrl: null,
      });

      const other = await member();
      await expect(
        setTemplatePreview(other, templateId, png),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        setTemplatePreview(author, templateId, Buffer.from("<svg/>")),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        setTemplatePreview(
          author,
          templateId,
          Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]),
        ),
      ).rejects.toMatchObject({ status: 400 });

      await setTemplatePreview(author, templateId, png);
      const key = `_templates/${templateId}/preview`;
      expect(bucket.get(key)?.contentType).toBe("image/png");
      const detail = await getTemplateForPost(postId);
      expect(detail?.customPreview).toBe(true);
      expect(detail?.previewUrl).toContain(
        `_templates/${templateId}/preview?v=`,
      );
      const [summary] = (
        await listPosts({ kind: "template", sort: "new", page: 1 })
      ).posts.filter((post) => post.id === postId);
      expect(summary.template?.customPreviewAt).toBeTruthy();

      // Replaced in place, its type from its bytes.
      await setTemplatePreview(author, templateId, webp);
      expect(bucket.get(key)?.contentType).toBe("image/webp");

      await expect(
        removeTemplatePreview(other, templateId),
      ).rejects.toMatchObject({ status: 403 });
      await removeTemplatePreview(author, templateId);
      expect(bucket.has(key)).toBe(false);
      expect(await getTemplateForPost(postId)).toMatchObject({
        customPreview: false,
      });
    });

    test("a workflow publishes the template's preview beside its files", async () => {
      const author = await member();
      const { postId, templateId } = await publishTemplatePost(author, {
        title: "커뮤",
        body: "",
        slug: `pv-${n}`,
        license: "mit",
        licenseAccepted: true,
        files: [],
        collections: [],
        source: "github",
        githubRepository: "naru-pub/preview",
        githubRef: "main",
      });
      const claims = {
        iss: "https://token.actions.githubusercontent.com",
        aud: "https://naru.pub",
        sub: "repo:naru-pub/preview:ref:refs/heads/main",
        exp: 0,
        repository: "naru-pub/preview",
        repository_id: "91",
        ref: "refs/heads/main",
        sha: "a".repeat(40),
      };
      const text = "<title>커뮤</title>";
      const manifest = {
        files: [
          {
            path: "index.html",
            size: Buffer.byteLength(text),
            sha256: sha256(Buffer.from(text)),
          },
        ],
      };
      const stage = (url: string, body: Buffer) =>
        bucket.set(url.slice("https://upload.test/".length), {
          size: body.byteLength,
          contentType: "application/octet-stream",
          etag: `"${++etags}"`,
          body,
        });
      const run = async (image: Buffer | null, sha: string) => {
        const plan = await planTemplateUpload({
          claims: { ...claims, sha },
          templateId,
          manifest,
          preview: image
            ? {
                size: image.byteLength,
                sha256: sha256(image),
                contentType: "image/png",
              }
            : undefined,
        });
        if ("skipped" in plan) throw new Error(plan.message);
        for (const target of plan.uploads) stage(target.url, Buffer.from(text));
        if (plan.previewUpload && image) stage(plan.previewUpload.url, image);
        return {
          plan,
          finalize: () =>
            finalizeTemplateUpload({
              claims: { ...claims, sha },
              deploymentId: plan.deploymentId,
            }),
        };
      };

      await expect(
        planTemplateUpload({
          claims,
          templateId,
          manifest,
          preview: { size: 10, sha256: "x", contentType: "image/png" },
        }),
      ).rejects.toThrow(/sha256/);

      const first = await run(png, "b".repeat(40));
      expect(first.plan.previewUpload).not.toBeNull();
      expect(await first.finalize()).toMatchObject({
        version: 1,
        previewUpdated: true,
      });
      expect(bucket.get(`_templates/${templateId}/preview`)?.contentType).toBe(
        "image/png",
      );
      expect((await getTemplateForPost(postId))?.customPreview).toBe(true);

      // The same image again is not uploaded.
      const again = await run(png, "c".repeat(40));
      expect(again.plan.previewUpload).toBeNull();
      expect(await again.finalize()).toMatchObject({
        unchanged: true,
        previewUpdated: false,
      });

      // A new image with the same files: no new version, a new preview.
      const changed = Buffer.concat([png, Buffer.from([9])]);
      const next = await run(changed, "d".repeat(40));
      expect(await next.finalize()).toMatchObject({
        version: 1,
        unchanged: true,
        previewUpdated: true,
      });
      expect(bucket.get(`_templates/${templateId}/preview`)?.size).toBe(
        changed.byteLength,
      );

      // A preview that isn't the image the plan named is refused, and the
      // template keeps the one it had.
      const swapped = await planTemplateUpload({
        claims: { ...claims, sha: "e".repeat(40) },
        templateId,
        manifest,
        preview: {
          size: png.byteLength,
          sha256: sha256(png),
          contentType: "image/png",
        },
      });
      if ("skipped" in swapped) throw new Error(swapped.message);
      stage(swapped.previewUpload!.url, Buffer.from("not the image"));
      await expect(
        finalizeTemplateUpload({
          claims: { ...claims, sha: "e".repeat(40) },
          deploymentId: swapped.deploymentId,
        }),
      ).rejects.toThrow(/preview/);
      expect(bucket.get(`_templates/${templateId}/preview`)?.size).toBe(
        changed.byteLength,
      );
    });
  });
});
