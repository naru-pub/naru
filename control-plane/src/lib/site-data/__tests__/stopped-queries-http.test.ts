/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
jest.mock("@/lib/auth", () => ({ validateRequest: jest.fn() }));
jest.mock("@/lib/entitlements", () => ({
  userHasFeature: jest.fn(async () => true),
}));
// Each user's site is their own login.
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
const { stoppedQueriesOwnerRequest } =
  require("../stopped-queries-http") as typeof import("../stopped-queries-http");
const auth = jest.mocked(
  (require("@/lib/auth") as typeof import("@/lib/auth")).validateRequest,
);
const call = jest.mocked(
  (require("@/lib/edge/client") as typeof import("@/lib/edge/client"))
    .callSiteObject,
);
const request = (
  method: "GET" | "POST",
  body?: unknown,
  origin = "http://localhost",
) =>
  new Request("http://localhost/api/account/stopped-queries", {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  jest.clearAllMocks();
  auth.mockResolvedValue({ user: { id: "owner" }, session: {} } as never);
});

test("the owner lists their site's paused statements and lets one run again", async () => {
  call.mockResolvedValueOnce([{ id: "t1", key: "query:posts:list:abc" }]);
  const listed = await stoppedQueriesOwnerRequest(request("GET"));
  expect(await listed.json()).toEqual({
    trips: [{ id: "t1", key: "query:posts:list:abc" }],
  });
  expect(call).toHaveBeenLastCalledWith("alice", "breakerTrips", {
    unnotified: false,
  });
  call.mockResolvedValueOnce(null);
  const cleared = await stoppedQueriesOwnerRequest(
    request("POST", { key: "query:posts:list:abc" }),
  );
  expect(cleared.status).toBe(200);
  expect(call).toHaveBeenLastCalledWith("alice", "clearBreaker", {
    key: "query:posts:list:abc",
  });
});

test("only the signed-in owner, from the same origin, with a key", async () => {
  expect(
    (
      await stoppedQueriesOwnerRequest(
        request("POST", { key: "k" }, "https://alice.naru.pub"),
      )
    ).status,
  ).toBe(403);
  expect(
    (await stoppedQueriesOwnerRequest(request("POST", { key: 1 }))).status,
  ).toBe(400);
  auth.mockResolvedValue({ user: null, session: null });
  expect((await stoppedQueriesOwnerRequest(request("GET"))).status).toBe(401);
  expect(call).not.toHaveBeenCalled();
});
