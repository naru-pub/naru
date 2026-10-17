/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
jest.mock("@/lib/auth", () => ({ validateRequest: jest.fn() }));
jest.mock("@/lib/entitlements", () => ({
  userHasFeature: jest.fn(async () => true),
}));
jest.mock("@/lib/database", () => ({
  db: {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirstOrThrow: async () => ({ login_name: "alice" }),
        }),
      }),
    }),
  },
}));
jest.mock("@/lib/edge/client", () => ({ callSiteObject: jest.fn() }));
jest.mock("@/lib/site-functions/storage", () => ({
  revisionStorage: { list: jest.fn(), get: jest.fn(), put: jest.fn() },
}));
const { restorePointsOwnerRequest } =
  require("../restore-points-http") as typeof import("../restore-points-http");
const auth = jest.mocked(
  (require("@/lib/auth") as typeof import("@/lib/auth")).validateRequest,
);
const call = jest.mocked(
  (require("@/lib/edge/client") as typeof import("@/lib/edge/client"))
    .callSiteObject,
);
const storage = (
  require("@/lib/site-functions/storage") as typeof import("@/lib/site-functions/storage")
).revisionStorage as unknown as Record<
  "list" | "get" | "put",
  jest.Mock<(...args: unknown[]) => Promise<unknown>>
>;

const first = "019a2b3c-4d5e-7000-8000-000000000001";
const second = "019a2b3c-5000-7000-8000-000000000002";
const request = (
  method: "GET" | "POST",
  body?: unknown,
  origin = "http://localhost",
) =>
  new Request("http://localhost/api/account/restore-points", {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  jest.clearAllMocks();
  auth.mockResolvedValue({ user: { id: "owner" }, session: {} } as never);
});

test("restore points are the owner's, from the same origin", async () => {
  auth.mockResolvedValue({ user: null, session: null });
  expect((await restorePointsOwnerRequest(request("GET"))).status).toBe(401);
  expect(
    (
      await restorePointsOwnerRequest(
        request("POST", { name: `${first}.json` }, "https://alice.naru.pub"),
      )
    ).status,
  ).toBe(403);
  expect(call).not.toHaveBeenCalled();
});

test("the list is the site's restore points, newest first", async () => {
  storage.list.mockResolvedValueOnce({
    objects: [
      {
        key: `_naru-runtime/alice/restore-points/${first}.json`,
        etag: "a",
        size: 10,
      },
      {
        key: "_naru-runtime/alice/restore-points/before-restore-1790000000000.json",
        etag: "b",
        size: 20,
      },
      {
        key: "_naru-runtime/alice/restore-points/stray.txt",
        etag: "c",
        size: 1,
      },
    ],
    truncated: true,
    cursor: "next",
  });
  storage.list.mockResolvedValueOnce({
    objects: [
      {
        key: `_naru-runtime/alice/restore-points/${second}.json`,
        etag: "d",
        size: 30,
      },
    ],
    truncated: false,
  });
  const response = await restorePointsOwnerRequest(request("GET"));
  expect(response.status).toBe(200);
  const { restorePoints } = await response.json();
  expect(storage.list).toHaveBeenCalledWith({
    prefix: "_naru-runtime/alice/restore-points/",
    cursor: undefined,
  });
  expect(restorePoints.map((p: { name: string }) => p.name)).toEqual([
    "before-restore-1790000000000.json",
    `${second}.json`,
    `${first}.json`,
  ]);
  expect(restorePoints[1]).toMatchObject({
    kind: "release",
    generation: second,
    size: 30,
  });
});

test("a restore asks the site's object, then writes the active release's routes", async () => {
  expect(
    (await restorePointsOwnerRequest(request("POST", { name: "../x.json" })))
      .status,
  ).toBe(400);
  expect(call).not.toHaveBeenCalled();
  call.mockResolvedValueOnce({
    revision: null,
    saved: "before-restore-1790000000000.json",
  });
  const response = await restorePointsOwnerRequest(
    request("POST", { name: `${first}.json` }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    revision: null,
    saved: {
      name: "before-restore-1790000000000.json",
      createdAt: 1_790_000_000_000,
      kind: "before-restore",
      generation: null,
    },
  });
  expect(call).toHaveBeenCalledWith(
    "alice",
    "restoreFrom",
    { name: `${first}.json` },
    undefined,
    expect.any(Number),
  );
  // A site without released code has no routes to write.
  expect(storage.put).not.toHaveBeenCalled();
});

test("the routes written are those of the release the object still runs", async () => {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const digest = "a".repeat(64);
  const body = JSON.stringify({
    version: 2,
    publication: "p",
    files: { "routes/index.js": digest, "queries/posts.js": digest },
  });
  const revision = createHash("sha256").update(body).digest("hex");
  storage.get.mockResolvedValueOnce({
    etag: "m",
    size: body.length,
    text: async () => body,
  });
  call.mockResolvedValueOnce({ revision, saved: "before-restore-1.json" });
  const response = await restorePointsOwnerRequest(
    request("POST", { name: `${first}.json` }),
  );
  expect(response.status).toBe(200);
  expect(storage.put).toHaveBeenCalledWith(
    "_naru-runtime/alice/routes.json",
    JSON.stringify({ revision, routes: ["index"] }),
  );
});
