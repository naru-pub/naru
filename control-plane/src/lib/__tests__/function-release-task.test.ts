/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
import type { TaskContext } from "absurd-sdk";
import type { FunctionRelease } from "@/lib/site-functions/releases";
const mockDeletedRows: string[] = [];
jest.mock("@/lib/edge/client", () => ({ callSiteObject: jest.fn() }));
jest.mock("@/lib/site-functions/storage", () => ({
  deleteRevision: jest.fn(),
  revisionStorage: { put: async () => {} },
}));
// A release without migrations or routes.
jest.mock("@/lib/site-functions/revisions", () => ({
  FunctionRevisions: class {
    async migrations() {
      return [];
    }
    async routes() {
      return [];
    }
  },
  routesKey: (site: string) => `_naru-runtime/${site}/routes.json`,
}));
jest.mock("@/lib/database", () => ({
  db: {
    selectFrom: () => {
      const query = {
        innerJoin: () => query,
        select: () => query,
        where: () => query,
        executeTakeFirst: async () => ({ id: "live" }),
      };
      return query;
    },
    // How a workflow deployment's release went (none here).
    updateTable: () => {
      const query = {
        set: () => query,
        where: () => query,
        execute: async () => [],
      };
      return query;
    },
    deleteFrom: () => {
      const query = {
        where: (key: string, _op: string, value: string) => {
          if (key === "id") mockDeletedRows.push(value);
          return query;
        },
        execute: async () => [],
      };
      return query;
    },
  },
}));
const { callSiteObject } =
  jest.requireMock<typeof import("@/lib/edge/client")>("@/lib/edge/client");
const { deleteRevision } = jest.requireMock<
  typeof import("@/lib/site-functions/storage")
>("@/lib/site-functions/storage");
const { runFunctionRelease } = jest.requireActual<
  typeof import("@/lib/site-functions/releases")
>("@/lib/site-functions/releases");
const activate = jest.mocked(callSiteObject),
  remove = jest.mocked(deleteRevision);
const release: FunctionRelease = {
  site: "alice",
  revision: "b".repeat(64),
  generation: "0199c012-0000-7000-8000-000000000001",
  retired: {
    id: "0199c011-0000-7000-8000-000000000001",
    revision: "a".repeat(64),
  },
};
function context() {
  const checkpoints = new Map<string, unknown>(),
    waits: number[] = [];
  return {
    waits,
    step: async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      if (checkpoints.has(name)) return checkpoints.get(name) as T;
      const result = await work();
      checkpoints.set(name, result);
      return result;
    },
    sleepFor: async (name: string, seconds: number) => {
      if (!checkpoints.has(name)) {
        waits.push(seconds);
        checkpoints.set(name, null);
      }
    },
    heartbeat: async () => {},
  } satisfies Pick<TaskContext, "step" | "sleepFor" | "heartbeat"> & {
    waits: number[];
  };
}
beforeEach(() => {
  activate.mockReset();
  activate.mockResolvedValue({ revision: release.revision });
  remove.mockReset();
  remove.mockResolvedValue();
  mockDeletedRows.length = 0;
});
test("activation, grace and deletion are checkpointed; a failed deletion retries without losing its row", async () => {
  const ctx = context();
  remove.mockRejectedValueOnce(new Error("R2 unavailable"));
  await expect(runFunctionRelease(release, ctx)).rejects.toThrow(
    "R2 unavailable",
  );
  expect(mockDeletedRows).toEqual([]);
  expect(ctx.waits).toEqual([300]);
  await runFunctionRelease(release, ctx);
  expect(activate).toHaveBeenCalledTimes(1);
  expect(activate).toHaveBeenCalledWith("alice", "activateFunctions", {
    revision: release.revision,
    generation: release.generation,
    site: "alice",
    migrations: [],
  });
  expect(remove).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenLastCalledWith(
    "alice",
    release.retired!.revision,
    expect.any(Function),
  );
  expect(mockDeletedRows).toEqual([release.retired!.id]);
});
test("first release has no retirement work", async () => {
  const ctx = context();
  await runFunctionRelease({ ...release, retired: null }, ctx);
  expect(ctx.waits).toEqual([]);
  expect(remove).not.toHaveBeenCalled();
});
test("activation failure does not start the grace period or delete code", async () => {
  activate.mockRejectedValueOnce(new Error("Edge unavailable"));
  const ctx = context();
  await expect(runFunctionRelease(release, ctx)).rejects.toThrow(
    "Edge unavailable",
  );
  expect(ctx.waits).toEqual([]);
  expect(remove).not.toHaveBeenCalled();
});
