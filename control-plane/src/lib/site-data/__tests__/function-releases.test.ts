/** @jest-environment node */
import { beforeAll, afterAll, expect, jest, test } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { callSiteObject } from "@/lib/edge/client";
import { setupTestDatabase, teardownTestDatabase } from "./test-database";
import type { RevisionBucket } from "@/lib/site-functions/revisions";
import type { FunctionRelease } from "@/lib/site-functions/releases";
import type { TaskContext } from "absurd-sdk";
const mockObjects = new Map<string, string>();
const mockDeletes: string[] = [];
jest.mock("@/lib/site-functions/storage", () => ({
  revisionStorage: {
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...mockObjects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, source]) => ({
          key,
          etag: source,
          size: Buffer.byteLength(source),
        })),
      truncated: false,
    }),
    get: async (key: string) => {
      const source = mockObjects.get(key);
      return source === undefined
        ? null
        : {
            etag: source,
            size: Buffer.byteLength(source),
            text: async () => source,
          };
    },
    put: async (key: string, source: string) => {
      mockObjects.set(key, source);
    },
  } satisfies RevisionBucket,
  deleteRevision: async (site: string, revision: string) => {
    mockDeletes.push(revision);
    for (const key of mockObjects.keys())
      if (key.startsWith(`_naru-runtime/${site}/revisions/${revision}/`))
        mockObjects.delete(key);
  },
}));
const { publishSiteFunctions, runFunctionRelease } = jest.requireActual<
  typeof import("@/lib/site-functions/releases")
>("@/lib/site-functions/releases");
const integration = process.env.NARU_DATA_TEST === "1" ? test : test.skip;
let ready = false;
beforeAll(async () => {
  if (process.env.NARU_DATA_TEST !== "1") return;
  await setupTestDatabase();
  ready = true;
  await db
    .insertInto("users")
    .values({ login_name: "release-owner" } as any)
    .execute();
});
afterAll(async () => {
  if (ready) await teardownTestDatabase();
  await db.destroy();
});
const site = "release-owner";
const context = () =>
  ({
    step: async <T>(_name: string, run: () => Promise<T>) => run(),
    sleepFor: async () => {},
    heartbeat: async () => {},
  }) satisfies Pick<TaskContext, "step" | "sleepFor" | "heartbeat">;

integration(
  "control plane records snapshots and durable retirement atomically; stale tasks cannot reactivate retired code",
  async () => {
    mockObjects.set(
      `${site}/_naru/functions/shop.js`,
      "export function buy() { return 1; }",
    );
    const first = await publishSiteFunctions(site);
    mockObjects.set(
      `${site}/_naru/functions/shop.js`,
      "export function buy() { return 2; }",
    );
    const second = await publishSiteFunctions(site);
    const tasks = await sql<{
      params: FunctionRelease;
    }>`select params from absurd.t_maintenance where task_name = 'function-release-v1' order by params->>'generation'`.execute(
      db,
    );
    expect(
      (
        await sql<{
          count: string;
        }>`select count(*) from absurd.t_maintenance where task_name = 'function-release-v1' and max_attempts is null`.execute(
          db,
        )
      ).rows[0].count,
    ).toBe("2");
    expect(tasks.rows).toHaveLength(2);
    expect(tasks.rows[1].params.retired!.revision).toBe(first.revision);
    expect(tasks.rows[1].params.revision).toBe(second.revision);
    expect(
      await callSiteObject(site, "activateFunctions", {
        revision: first.revision,
        generation: tasks.rows[0].params.generation,
      }),
    ).toEqual({ revision: second.revision });
    await runFunctionRelease(tasks.rows[1].params, context());
    // Even a late first-release task cannot restore its deleted source directory.
    await runFunctionRelease(tasks.rows[0].params, context());
    expect(mockDeletes).toEqual([first.revision]);
    expect(
      [...mockObjects.keys()].some((key) =>
        key.startsWith(`_naru-runtime/${site}/revisions/${first.revision}/`),
      ),
    ).toBe(false);
    expect(
      mockObjects.get(
        `_naru-runtime/${site}/revisions/${second.revision}/functions/shop.js`,
      ),
    ).toContain("return 2");
    expect(
      await db
        .selectFrom("site_function_releases")
        .select("revision")
        .execute(),
    ).toEqual([{ revision: second.revision }]);
  },
);

integration(
  "refused snapshots do not advance the release record or enqueue retirement",
  async () => {
    const before = await db
      .selectFrom("site_function_releases")
      .selectAll()
      .execute();
    mockObjects.set(
      `${site}/_naru/functions/shop.js`,
      'import "../modules/missing.js";',
    );
    await expect(publishSiteFunctions(site)).rejects.toThrow("Missing import");
    expect(
      await db.selectFrom("site_function_releases").selectAll().execute(),
    ).toEqual(before);
    expect(
      (
        await sql<{
          count: string;
        }>`select count(*) from absurd.t_maintenance where task_name = 'function-release-v1'`.execute(
          db,
        )
      ).rows[0].count,
    ).toBe("2");
  },
);
