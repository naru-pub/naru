/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
jest.mock("@/lib/auth", () => ({ validateRequest: jest.fn() }));
jest.mock("@/lib/entitlements", () => ({
  userHasFeature: jest.fn(async () => true),
}));
// Each user's site is their own login: "owner" is alice's.
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
  revisionStorage: {},
  openRestorePoint: jest.fn(),
}));
const { siteTablesOwnerRequest } =
  require("../site-tables-http") as typeof import("../site-tables-http");
const auth = jest.mocked(
  (require("@/lib/auth") as typeof import("@/lib/auth")).validateRequest,
);
const call = jest.mocked(
  (require("@/lib/edge/client") as typeof import("@/lib/edge/client"))
    .callSiteObject,
);
const { DataError } =
  require("../validation") as typeof import("../validation");

const request = (query = "", origin = "http://localhost") =>
  new Request(`http://localhost/api/account/site-tables${query}`, {
    headers: { Origin: origin },
  });

beforeEach(() => {
  jest.clearAllMocks();
  auth.mockResolvedValue({ user: { id: "owner" }, session: {} } as never);
});

test("a site's tables are its owner's, from the same origin", async () => {
  auth.mockResolvedValue({ user: null, session: null });
  expect((await siteTablesOwnerRequest(request())).status).toBe(401);
  auth.mockResolvedValue({ user: { id: "owner" }, session: {} } as never);
  expect(
    (await siteTablesOwnerRequest(request("", "https://alice.naru.pub")))
      .status,
  ).toBe(403);
  expect(call).not.toHaveBeenCalled();
});

test("lists the owner's tables and pages one", async () => {
  call.mockResolvedValueOnce([{ name: "posts", view: false, columns: [] }]);
  const listed = await siteTablesOwnerRequest(request());
  expect(await listed.json()).toEqual({
    tables: [{ name: "posts", view: false, columns: [] }],
  });
  expect(call).toHaveBeenLastCalledWith("alice", "siteTables", {});

  const page = { table: "posts", columns: ["id"], rows: [[1]], next: null };
  call.mockResolvedValueOnce(page);
  const paged = await siteTablesOwnerRequest(request("?table=posts&after=-20"));
  expect(paged.headers.get("Cache-Control")).toBe("no-store");
  expect(await paged.json()).toEqual(page);
  expect(call).toHaveBeenLastCalledWith("alice", "tableRows", {
    table: "posts",
    after: -20,
  });
});

test("passes the object's refusals on, and refuses an odd page itself", async () => {
  expect(
    (await siteTablesOwnerRequest(request("?table=posts&after=x"))).status,
  ).toBe(400);
  call.mockRejectedValueOnce(new DataError(404, "The site has no table meta."));
  const refused = await siteTablesOwnerRequest(request("?table=meta"));
  expect(refused.status).toBe(404);
  expect(await refused.json()).toMatchObject({
    error: { message: "The site has no table meta." },
  });
});
