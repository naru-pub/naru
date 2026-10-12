/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
jest.mock("@/lib/auth", () => ({ validateRequest: jest.fn() }));
jest.mock("../membership", () => ({ manageMembership: jest.fn() }));
const { membershipOwnerRequest } =
  require("../membership-http") as typeof import("../membership-http");
const auth = jest.mocked(
  (require("@/lib/auth") as typeof import("@/lib/auth")).validateRequest,
);
const membership = jest.mocked(
  (require("../membership") as typeof import("../membership")).manageMembership,
);
beforeEach(() => {
  jest.clearAllMocks();
});

test("membership administration rejects cross-origin cookies and collection tokens", async () => {
  for (const origin of ["https://alice.naru.pub", "null", ""]) {
    const response = await membershipOwnerRequest(
      new Request("https://naru.pub/api/account/site-members", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
          Authorization: `Bearer ${"t".repeat(43)}`,
          Cookie: "auth_session=owner",
        },
        body: JSON.stringify({ admission: "closed" }),
      }),
    );
    expect(response.status).toBe(403);
  }
  expect(auth).not.toHaveBeenCalled();
  expect(membership).not.toHaveBeenCalled();
  auth.mockResolvedValue({ user: null, session: null });
  const response = await membershipOwnerRequest(
    new Request("https://naru.pub/api/account/site-members", {
      method: "PATCH",
      headers: {
        Origin: "https://naru.pub",
        "Content-Type": "application/json",
        Authorization: `Bearer ${"t".repeat(43)}`,
      },
      body: JSON.stringify({ admission: "closed" }),
    }),
  );
  expect(response.status).toBe(401);
  expect(membership).not.toHaveBeenCalled();
});
