/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
jest.mock("@/lib/auth", () => ({ validateRequest: jest.fn() }));
jest.mock("@/lib/entitlements", () => ({
  userHasFeature: jest.fn(async () => true),
}));
// Each user's site is their own login: "owner" is alice's, anyone else
// mallory's.
jest.mock("@/lib/database", () => ({
  db: {
    selectFrom: () => ({
      select: () => ({
        where: (_column: string, _op: string, id: string) => ({
          executeTakeFirstOrThrow: async () => ({
            login_name: id === "owner" ? "alice" : "mallory",
          }),
        }),
      }),
    }),
  },
}));
jest.mock("@/lib/edge/client", () => ({ callSiteObject: jest.fn() }));
jest.mock("@/lib/site-functions/storage", () => ({
  revisionStorage: { list: jest.fn(), get: jest.fn(), put: jest.fn() },
  openRestorePoint: jest.fn(),
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
const storageModule =
  require("@/lib/site-functions/storage") as typeof import("@/lib/site-functions/storage");
const storage = storageModule.revisionStorage as unknown as Record<
  "list" | "get" | "put",
  jest.Mock<(...args: unknown[]) => Promise<unknown>>
>;
const open = jest.mocked(storageModule.openRestorePoint);

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
/** A download as a link opens it: a GET with no Origin. */
const download = (name: string, fetchSite = "same-origin") =>
  new Request(
    `http://localhost/api/account/restore-points?download=${encodeURIComponent(name)}`,
    { headers: { "Sec-Fetch-Site": fetchSite } },
  );

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
        request(
          "POST",
          { name: `${first}.ndjson.gz` },
          "https://alice.naru.pub",
        ),
      )
    ).status,
  ).toBe(403);
  expect(call).not.toHaveBeenCalled();
});

test("the list is the site's restore points, newest first", async () => {
  storage.list.mockResolvedValueOnce({
    objects: [
      {
        key: `_naru-runtime/alice/restore-points/${first}.ndjson.gz`,
        etag: "a",
        size: 10,
      },
      {
        key: "_naru-runtime/alice/restore-points/before-restore-1790000000000.ndjson.gz",
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
        key: `_naru-runtime/alice/restore-points/${second}.ndjson.gz`,
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
    "before-restore-1790000000000.ndjson.gz",
    `${second}.ndjson.gz`,
    `${first}.ndjson.gz`,
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
    saved: "before-restore-1790000000000.ndjson.gz",
  });
  const response = await restorePointsOwnerRequest(
    request("POST", { name: `${first}.ndjson.gz` }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    revision: null,
    saved: {
      name: "before-restore-1790000000000.ndjson.gz",
      createdAt: 1_790_000_000_000,
      kind: "before-restore",
      generation: null,
    },
  });
  expect(call).toHaveBeenCalledWith(
    "alice",
    "restoreFrom",
    { name: `${first}.ndjson.gz` },
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
  call.mockResolvedValueOnce({ revision, saved: "before-restore-1.ndjson.gz" });
  const response = await restorePointsOwnerRequest(
    request("POST", { name: `${first}.ndjson.gz` }),
  );
  expect(response.status).toBe(200);
  expect(storage.put).toHaveBeenCalledWith(
    "_naru-runtime/alice/routes.json",
    JSON.stringify({ revision, routes: ["index"] }),
  );
});

test("a restore point downloads as a gzip file, streamed from the site's own", async () => {
  const name = `${first}.ndjson.gz`;
  let pulled = 0;
  const parts = [new Uint8Array([0x1f, 0x8b, 1]), new Uint8Array([2, 3])];
  open.mockResolvedValueOnce({
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[pulled++];
        if (part) controller.enqueue(part);
        else controller.close();
      },
    }),
    size: 5,
  });
  const response = await restorePointsOwnerRequest(download(name));
  expect(response.status).toBe(200);
  expect(open).toHaveBeenCalledWith(
    `_naru-runtime/alice/restore-points/${name}`,
  );
  expect(response.headers.get("content-type")).toBe("application/gzip");
  expect(response.headers.get("content-length")).toBe("5");
  expect(response.headers.get("content-disposition")).toBe(
    `attachment; filename="alice-${name}"`,
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  // Passed on as R2 sends it, not read first.
  expect(pulled).toBeLessThan(parts.length + 1);
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
    0x1f, 0x8b, 1, 2, 3,
  ]);
});

test("a download is the signed-in owner's, of their own site, by a restore point's name", async () => {
  const name = `${first}.ndjson.gz`;
  auth.mockResolvedValueOnce({ user: null, session: null });
  expect((await restorePointsOwnerRequest(download(name))).status).toBe(401);
  expect(
    (await restorePointsOwnerRequest(download(name, "cross-site"))).status,
  ).toBe(403);
  expect(
    (await restorePointsOwnerRequest(download("../../bob/secret"))).status,
  ).toBe(400);
  expect(open).not.toHaveBeenCalled();
  // Another user names alice's point: only their own site is read.
  auth.mockResolvedValueOnce({ user: { id: "mallory" }, session: {} } as never);
  open.mockResolvedValueOnce(null);
  const other = await restorePointsOwnerRequest(download(name));
  expect(other.status).toBe(404);
  expect(open).toHaveBeenCalledWith(
    `_naru-runtime/mallory/restore-points/${name}`,
  );
});

test("the owner keeps a restore point now, which the site's object writes", async () => {
  call.mockResolvedValueOnce({
    name: "manual-1790000000000.ndjson.gz",
    bytes: 1234,
  });
  const response = await restorePointsOwnerRequest(
    request("POST", { create: true }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    saved: {
      name: "manual-1790000000000.ndjson.gz",
      createdAt: 1_790_000_000_000,
      kind: "manual",
      generation: null,
      size: 1234,
    },
  });
  expect(call).toHaveBeenCalledWith(
    "alice",
    "saveRestorePoint",
    {},
    undefined,
    expect.any(Number),
  );
  // Another user's request keeps one of their own site, never alice's.
  auth.mockResolvedValueOnce({ user: { id: "mallory" }, session: {} } as never);
  call.mockResolvedValueOnce({ name: "manual-1.ndjson.gz", bytes: 1 });
  await restorePointsOwnerRequest(request("POST", { create: true }));
  expect(call).toHaveBeenLastCalledWith(
    "mallory",
    "saveRestorePoint",
    {},
    undefined,
    expect.any(Number),
  );
  // Signed out, or from another origin, nothing is kept.
  call.mockClear();
  auth.mockResolvedValueOnce({ user: null, session: null });
  expect(
    (await restorePointsOwnerRequest(request("POST", { create: true }))).status,
  ).toBe(401);
  expect(
    (
      await restorePointsOwnerRequest(
        request("POST", { create: true }, "https://alice.naru.pub"),
      )
    ).status,
  ).toBe(403);
  expect(call).not.toHaveBeenCalled();
});

test("the object's refusals, one at a time and a few an hour, reach the owner", async () => {
  const { DataError } =
    require("../validation") as typeof import("../validation");
  call.mockRejectedValueOnce(
    new DataError(429, "At most 3 restore points an hour.", "RATE_LIMITED"),
  );
  const limited = await restorePointsOwnerRequest(
    request("POST", { create: true }),
  );
  expect(limited.status).toBe(429);
  expect((await limited.json()).error).toMatchObject({ code: "RATE_LIMITED" });
  call.mockRejectedValueOnce(
    new DataError(409, "A restore point is already being made.", "CONFLICT"),
  );
  expect(
    (await restorePointsOwnerRequest(request("POST", { create: true }))).status,
  ).toBe(409);
});
