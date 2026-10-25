/** @jest-environment node */
// Templates made before updatable templates (migration
// 1792850254347_updatable_templates) come through it as they were: the
// database is taken back to the migration before it, templates are made the
// way they were then, and the migration runs again over them.
import { afterAll, describe, expect, jest, test } from "@jest/globals";
// An in-memory bucket stands in for R2, as in board.test.ts.
const bucket = new Map<string, { size: number; etag: string }>();
jest.mock("../storage", () => ({
  listObjects: jest.fn(async (prefix: string) =>
    [...bucket]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, ...value })),
  ),
  copyObject: jest.fn(async (source: string, target: string) => {
    const object = bucket.get(source);
    if (!object) throw new Error(`no such key: ${source}`);
    bucket.set(target, { ...object });
  }),
  deleteObjects: jest.fn(async (keys: string[]) => {
    for (const key of keys) bucket.delete(key);
  }),
  deletePrefix: jest.fn(async () => {}),
  purgeSiteFiles: jest.fn(async () => {}),
}));
jest.mock("../limits", () => ({
  assertUnderHourlyLimit: jest.fn(async () => {}),
}));
jest.mock("@/lib/entitlements", () => ({
  getUserFeatures: jest.fn(async () => new Set(["database"])),
  userHasFeature: jest.fn(async () => true),
}));
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { User } from "@/lib/auth";
const { sql } = require("kysely") as typeof import("kysely");
const { FileMigrationProvider, Migrator } =
  require("kysely/migration") as typeof import("kysely/migration");
const { db } = require("@/lib/database") as typeof import("@/lib/database");
const {
  applyTemplate,
  getTemplateForPost,
  planApplication,
  publishTemplateVersion,
} = require("../templates") as typeof import("../templates");
const { listInstalls } = require("../updates") as typeof import("../updates");

const integration =
  process.env.NARU_BOARD_TEST === "1" ? describe : describe.skip;

const THIS = "1792850254347_updatable_templates";
const BEFORE = "1792821018829_site_member_supporters_only";

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({
    fs,
    path,
    migrationFolder: path.join(__dirname, "../../../migrations"),
  }),
});
async function migrateTo(name: string) {
  const { error } = await migrator.migrateTo(name);
  if (error) throw error;
}

integration("updatable templates migration", () => {
  afterAll(async () => {
    // The other tests run on the latest schema.
    await migrator.migrateToLatest();
    await db.destroy();
  });

  test("existing templates, versions, files and applications migrate cleanly", async () => {
    await migrateTo(BEFORE);
    // As the schema stood: no source, no site code, no installs.
    const login = `upgrade${Date.now().toString(36)}`;
    const {
      rows: [user],
    } = await sql<{ id: string }>`
      insert into users (login_name, password_hash, email, email_verified_at)
      values (${login}, 'x', ${`${login}@example.com`}, now()) returning id`.execute(
      db,
    );
    const {
      rows: [post],
    } = await sql<{ id: string }>`
      insert into board_posts (user_id, kind, title, body)
      values (${user.id}, 'template', '오래된 템플릿', '본문') returning id`.execute(
      db,
    );
    const {
      rows: [template],
    } = await sql<{ id: string }>`
      insert into board_templates (post_id, user_id, slug, license)
      values (${post.id}, ${user.id}, 'old-one', 'cc-by-4.0') returning id`.execute(
      db,
    );
    const version = async (
      number: number,
      files: string[],
    ): Promise<string> => {
      const {
        rows: [row],
      } = await sql<{ id: string }>`
        insert into board_template_versions
          (template_id, version, source_path, file_count, size_bytes, changelog)
        values (${template.id}, ${number}, 'old/', ${files.length}, ${files.length * 10}, ${`v${number}`})
        returning id`.execute(db);
      for (const file of files) {
        await sql`
          insert into board_template_files (version_id, path, size_bytes, content_type)
          values (${row.id}, ${file}, 10, 'text/html')`.execute(db);
        bucket.set(`_templates/${template.id}/v${number}/${file}`, {
          size: 10,
          etag: `"${number}-${file}"`,
        });
      }
      return row.id;
    };
    const plainId = await version(1, ["index.html", "style.css"]);
    // A path with an underscore that is not site code.
    const codeId = await version(2, [
      "index.html",
      "_naru/queries/posts.js",
      "_naruish.html",
    ]);
    await sql`update board_templates set latest_version_id = ${codeId} where id = ${template.id}`.execute(
      db,
    );
    await sql`insert into board_template_applications (version_id, user_id) values (${plainId}, ${user.id})`.execute(
      db,
    );
    const applicationsBefore = (
      await sql<{
        n: number;
      }>`select count(*)::int as n from board_template_applications`.execute(db)
    ).rows[0].n;

    await migrateTo(THIS);

    // The template keeps its license and publishes from its author's site.
    const migrated = await db
      .selectFrom("board_templates")
      .select([
        "license",
        "source",
        "github_repository",
        "github_ref",
        "github_repository_id",
        "latest_version_id",
        "apply_count",
      ])
      .where("id", "=", template.id)
      .executeTakeFirstOrThrow();
    expect(migrated).toEqual({
      license: "cc-by-4.0",
      source: "site",
      github_repository: null,
      github_ref: null,
      github_repository_id: null,
      latest_version_id: codeId,
      apply_count: 0,
    });
    // Site code is backfilled from each version's files, nothing else.
    const versions = await db
      .selectFrom("board_template_versions")
      .select(["id", "site_code", "github_sha", "changelog", "file_count"])
      .where("template_id", "=", template.id)
      .orderBy("version")
      .execute();
    expect(versions).toEqual([
      {
        id: plainId,
        site_code: false,
        github_sha: null,
        changelog: "v1",
        file_count: 2,
      },
      {
        id: codeId,
        site_code: true,
        github_sha: null,
        changelog: "v2",
        file_count: 3,
      },
    ]);
    const files = await db
      .selectFrom("board_template_files")
      .select(["version_id", "path", "sha256", "etag"])
      .where("version_id", "in", [plainId, codeId])
      .orderBy("path")
      .execute();
    expect(files).toHaveLength(5);
    expect(files.every((f) => f.sha256 === null && f.etag === null)).toBe(true);
    // Applications stay; none of them became an install.
    expect(
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from board_template_applications`.execute(
          db,
        )
      ).rows[0].n,
    ).toBe(applicationsBefore);
    expect(
      await db
        .selectFrom("board_template_installs")
        .select("id")
        .where("user_id", "=", user.id)
        .execute(),
    ).toEqual([]);

    // Later migrations too, then it reads, applies and publishes as a
    // template of today does.
    const latest = await migrator.migrateToLatest();
    if (latest.error) throw latest.error;
    expect(
      await db
        .selectFrom("board_templates")
        .select("github_path")
        .where("id", "=", template.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ github_path: null });
    const detail = await getTemplateForPost(post.id);
    expect(detail).toMatchObject({
      source: "site",
      github: null,
      license: "cc-by-4.0",
    });
    expect(detail!.versions.map((v) => [v.version, v.siteCode])).toEqual([
      [2, true],
      [1, false],
    ]);
    const me: User = {
      id: user.id,
      loginName: login,
      createdAt: new Date(),
      email: `${login}@example.com`,
      emailVerifiedAt: new Date(),
      discoverable: false,
    };
    expect((await planApplication(me, plainId, "copy")).blockers).toEqual([]);
    const applied = await applyTemplate(me, plainId, {
      targetPath: "copy",
      backup: true,
      createCollections: true,
    });
    expect(bucket.has(`${login}/copy/index.html`)).toBe(true);
    // Files without a recorded ETag are compared by the site's own.
    const [install] = await listInstalls(me);
    expect(install).toMatchObject({
      id: applied.installId,
      targetPath: "copy/",
      updates: "notify",
      version: { id: plainId, version: 1 },
      latest: { id: codeId, version: 2 },
    });

    bucket.set(`${login}/old/index.html`, { size: 10, etag: '"new"' });
    expect(
      await publishTemplateVersion(me, template.id, {
        files: ["old/index.html"],
        changelog: "새 버전",
        collections: [],
      }),
    ).toBe(3);

    // And the migration can be taken back.
    await migrateTo(BEFORE);
    const columns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = 'board_templates' and column_name = 'source'`.execute(
      db,
    );
    expect(columns.rows).toEqual([]);
    await migrator.migrateToLatest();
  });
});
