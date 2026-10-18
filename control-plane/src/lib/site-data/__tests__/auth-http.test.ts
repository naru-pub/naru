/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
jest.mock("@/lib/auth", () => ({ validateRequest: jest.fn() }));
jest.mock("../owner-auth", () => ({
  exchangeCode: jest.fn(),
  updateClient: jest.fn(),
  approveAuthorization: jest.fn(),
  authorizationInput: jest.fn((x: unknown) => x),
  revokeToken: jest.fn(),
  registerClient: jest.fn(),
  removeClient: jest.fn(),
  revokeClientTokens: jest.fn(),
}));
jest.mock("../member-auth", () => ({
  approveMemberSignIn: jest.fn(),
  exchangeMemberCode: jest.fn(),
  memberSignInInput: jest.fn((x: unknown) => x),
  revokeMemberToken: jest.fn(),
}));
const { ownerAuthRequest } =
  require("../auth-http") as typeof import("../auth-http");
const auth = jest.mocked(
  (require("@/lib/auth") as typeof import("@/lib/auth")).validateRequest,
);
const owner = jest.mocked(
  require("../owner-auth") as typeof import("../owner-auth"),
);
const member = jest.mocked(
  require("../member-auth") as typeof import("../member-auth"),
);
beforeEach(() => {
  jest.clearAllMocks();
});

test.each(["authorize", "clients", "member-authorize"])(
  "%s requires same-origin confirmation even with login cookies",
  async (action) => {
    for (const origin of ["https://alice.naru.pub", "null", ""]) {
      const response = await ownerAuthRequest(
        new Request(`https://naru.pub/api/data-auth/${action}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(origin ? { Origin: origin } : {}),
            Cookie: "auth_session=owner",
          },
          body: "{}",
        }),
        action,
      );
      expect(response.status).toBe(403);
      expect(auth).not.toHaveBeenCalled();
    }
  },
);
test("authorization cannot issue codes without an authenticated owner", async () => {
  auth.mockResolvedValue({ user: null, session: null });
  const response = await ownerAuthRequest(
    new Request("https://naru.pub/api/data-auth/authorize", {
      method: "POST",
      headers: {
        Origin: "https://naru.pub",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    "authorize",
  );
  expect(response.status).toBe(401);
  expect(owner.approveAuthorization).not.toHaveBeenCalled();
});
test("token exchange ignores ambient cookies and forwards origin to grant verification", async () => {
  owner.exchangeCode.mockResolvedValue({
    accessToken: "t".repeat(43),
    tokenType: "Bearer",
    expiresIn: 86400,
    expiresAt: Date.now() + 24 * 3600000,
  });
  const body = {
    code: "code",
    verifier: "verifier",
    redirectUri: "https://alice.example/admin",
  };
  const response = await ownerAuthRequest(
    new Request("https://naru.pub/api/data-auth/v1/token", {
      method: "POST",
      headers: {
        Origin: "https://alice.example",
        "Content-Type": "application/json",
        Cookie: "auth_session=owner",
      },
      body: JSON.stringify(body),
    }),
    "token",
  );
  expect(response.status).toBe(200);
  expect(Object.keys(await response.json()).sort()).toEqual([
    "accessToken",
    "expiresAt",
    "expiresIn",
  ]);
  expect(owner.exchangeCode).toHaveBeenCalledWith(
    body,
    "https://alice.example",
  );
  expect(auth).not.toHaveBeenCalled();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
});
test("revocation requires explicit bearer credentials", async () => {
  const response = await ownerAuthRequest(
    new Request("https://naru.pub/api/data-auth/v1/revoke", {
      method: "POST",
      headers: {
        Origin: "https://alice.example",
        Cookie: "auth_session=owner",
      },
    }),
    "revoke",
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: { code: "AUTH_REQUIRED", message: "Invalid owner token." },
  });
  expect(owner.revokeToken).not.toHaveBeenCalled();
});

test.each(["refresh", "end-session"])(
  "removed route %s returns 404",
  async (action) => {
    const route =
      require("@/app/(main)/api/data-auth/[action]/route") as typeof import("@/app/(main)/api/data-auth/[action]/route");
    const response = await route.POST(
      new Request(`https://naru.pub/api/data-auth/${action}`, {
        method: "POST",
        headers: {
          Origin: "https://alice.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      { params: Promise.resolve({ action }) },
    );
    expect(response.status).toBe(404);
  },
);

test("website calls answer only under v1, and the consent approval only outside it", async () => {
  const legacy =
    require("@/app/(main)/api/data-auth/[action]/route") as typeof import("@/app/(main)/api/data-auth/[action]/route");
  const v1 =
    require("@/app/(main)/api/data-auth/v1/[action]/route") as typeof import("@/app/(main)/api/data-auth/v1/[action]/route");
  const post = (route: Pick<typeof v1, "POST">, action: string) =>
    route.POST(
      new Request(`https://naru.pub/api/data-auth/${action}`, {
        method: "POST",
        headers: {
          Origin: "https://alice.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      { params: Promise.resolve({ action }) },
    );
  for (const action of ["discover", "token", "revoke"]) {
    const response = await post(legacy, action);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
  }
  // Sign-in no longer discovers anything; the consent page identifies the
  // registration by site and exact callback.
  for (const action of ["authorize", "discover"]) {
    const response = await post(v1, action);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Not found." },
    });
  }
  expect(owner.approveAuthorization).not.toHaveBeenCalled();
});

test("a member's approval needs the member's own Naru sign-in, not the database", async () => {
  const approve = (cookie: string, extra = {}) =>
    ownerAuthRequest(
      new Request("https://naru.pub/api/data-auth/member-authorize", {
        method: "POST",
        headers: {
          Origin: "https://naru.pub",
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ site: "alice", ...extra }),
      }),
      "member-authorize",
    );
  auth.mockResolvedValue({ user: null, session: null });
  expect((await approve("")).status).toBe(401);
  expect(member.approveMemberSignIn).not.toHaveBeenCalled();
  auth.mockResolvedValue({
    user: { id: "bob" },
    session: { id: "bob-session" },
  } as never);
  member.approveMemberSignIn.mockResolvedValue({
    redirect: "https://alice.example/?code=c&state=s",
  });
  const response = await approve("auth_session=bob");
  expect(response.status).toBe(200);
  // The body as the (mocked) input parser returned it.
  // A page from before the notifications box sends no answer.
  expect(member.approveMemberSignIn).toHaveBeenCalledWith(
    "bob",
    "bob-session",
    expect.objectContaining({ site: "alice" }),
    undefined,
  );
  await approve("auth_session=bob", { notifications: false });
  expect(member.approveMemberSignIn).toHaveBeenLastCalledWith(
    "bob",
    "bob-session",
    expect.objectContaining({ site: "alice" }),
    false,
  );
});

test("a member's code exchange and sign-out are website calls, with CORS for the page", async () => {
  member.exchangeMemberCode.mockResolvedValue({
    accessToken: `m.${"t".repeat(43)}`,
    expiresIn: 604800,
    expiresAt: Date.now() + 604800000,
    memberId: "0190f1a2-0000-7000-8000-000000000001",
  });
  const body = {
    code: "code",
    verifier: "verifier",
    redirectUri: "https://alice.example/board/",
  };
  const response = await ownerAuthRequest(
    new Request("https://naru.pub/api/data-auth/v1/member-token", {
      method: "POST",
      headers: {
        Origin: "https://alice.example",
        "Content-Type": "application/json",
        Cookie: "auth_session=bob",
      },
      body: JSON.stringify(body),
    }),
    "member-token",
  );
  expect(response.status).toBe(200);
  expect(Object.keys(await response.json()).sort()).toEqual([
    "accessToken",
    "expiresAt",
    "expiresIn",
    "memberId",
  ]);
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "https://alice.example",
  );
  expect(member.exchangeMemberCode).toHaveBeenCalledWith(
    body,
    "https://alice.example",
  );
  expect(auth).not.toHaveBeenCalled();
  // Only a member token is revoked here.
  for (const authorization of ["", `Bearer ${"t".repeat(43)}`]) {
    const refused = await ownerAuthRequest(
      new Request("https://naru.pub/api/data-auth/v1/member-revoke", {
        method: "POST",
        headers: {
          Origin: "https://alice.example",
          Authorization: authorization,
        },
      }),
      "member-revoke",
    );
    expect(refused.status).toBe(401);
  }
  const revoked = await ownerAuthRequest(
    new Request("https://naru.pub/api/data-auth/v1/member-revoke", {
      method: "POST",
      headers: {
        Origin: "https://alice.example",
        Authorization: `Bearer m.${"t".repeat(43)}`,
      },
    }),
    "member-revoke",
  );
  expect(revoked.status).toBe(200);
  expect(member.revokeMemberToken).toHaveBeenCalledWith(
    `m.${"t".repeat(43)}`,
    "https://alice.example",
  );
});

test("member routes answer where the SDK calls them, and nowhere else", async () => {
  const legacy =
    require("@/app/(main)/api/data-auth/[action]/route") as typeof import("@/app/(main)/api/data-auth/[action]/route");
  const v1 =
    require("@/app/(main)/api/data-auth/v1/[action]/route") as typeof import("@/app/(main)/api/data-auth/v1/[action]/route");
  const post = (route: Pick<typeof v1, "POST">, action: string) =>
    route.POST(
      new Request(`https://naru.pub/api/data-auth/${action}`, {
        method: "POST",
        headers: {
          Origin: "https://alice.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      { params: Promise.resolve({ action }) },
    );
  for (const action of ["member-token", "member-revoke"])
    expect((await post(legacy, action)).status).toBe(404);
  expect((await post(v1, "member-authorize")).status).toBe(404);
});
