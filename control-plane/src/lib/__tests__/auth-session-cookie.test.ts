/** @jest-environment node */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

// An in-memory sessions table behind the few Kysely chains auth.ts uses.
const sessions = new Map<
  string,
  { user_id: string; expires_at: Date; impersonator_session_id?: string | null }
>();
const user = {
  user_id: "user-1",
  login_name: "alice",
  created_at: new Date("2026-01-01T00:00:00Z"),
  email: null,
  email_verified_at: null,
  discoverable: true,
  deleted_at: null as Date | null,
};
jest.mock("../database", () => ({
  db: {
    selectFrom: () => {
      let id = "";
      let liveOnly = false;
      const chain = {
        innerJoin: () => chain,
        select: () => chain,
        where: (column: string, _: string, value: string | null) => {
          if (column === "sessions.id") id = value!;
          if (column === "users.deleted_at") liveOnly = true;
          return chain;
        },
        executeTakeFirst: async () => {
          const row = sessions.get(id);
          return row && (!liveOnly || user.deleted_at === null)
            ? {
                ...user,
                user_id: row.user_id,
                session_id: id,
                session_expires_at: row.expires_at,
                impersonator_session_id: row.impersonator_session_id ?? null,
              }
            : undefined;
        },
      };
      return chain;
    },
    insertInto: () => ({
      values: (row: {
        id: string;
        user_id: string;
        expires_at: Date;
        impersonator_session_id: string | null;
      }) => ({
        execute: async () => void sessions.set(row.id, row),
      }),
    }),
    deleteFrom: () => ({
      where: (_: string, __: string, id: string) => ({
        execute: async () => void sessions.delete(id),
      }),
    }),
    updateTable: () => ({
      set: (values: { expires_at: Date }) => ({
        where: (_: string, __: string, id: string) => ({
          execute: async () =>
            void sessions.set(id, { ...sessions.get(id)!, ...values }),
        }),
      }),
    }),
  },
}));
jest.mock("react", () => ({ cache: (fn: unknown) => fn }));

// The request's Cookie header, and the cookies the response sets. canSet is
// false while a page renders.
let cookieHeader = "";
let canSet = true;
let setCookies: Array<{ name: string; value: string; options: any }> = [];
jest.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: cookieHeader }),
  cookies: async () => {
    const jar = new Map<string, string>();
    for (const pair of cookieHeader.split(";")) {
      const [name, ...value] = pair.trim().split("=");
      if (name && !jar.has(name)) jar.set(name, value.join("="));
    }
    return {
      get: (name: string) =>
        jar.has(name) ? { name, value: jar.get(name)! } : undefined,
      has: (name: string) => jar.has(name),
      set: (name: string, value: string, options: unknown) => {
        if (!canSet) throw new Error("Cookies can only be modified in a route");
        setCookies.push({ name, value, options });
      },
    };
  },
}));

function loadAuth(nodeEnv: string): typeof import("../auth") {
  const previous = process.env.NODE_ENV;
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  let auth!: typeof import("../auth");
  jest.isolateModules(() => {
    auth = require("../auth");
  });
  (process.env as Record<string, string>).NODE_ENV = previous!;
  return auth;
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

beforeEach(() => {
  sessions.clear();
  user.deleted_at = null;
  cookieHeader = "";
  canSet = true;
  setCookies = [];
});

describe("production session cookie", () => {
  test("is issued as a __Host- cookie: Secure, Path=/, no Domain", async () => {
    const auth = loadAuth("production");
    const session = await auth.createSession("user-1");
    await auth.setSessionCookie(session);
    expect(setCookies).toEqual([
      {
        name: "__Host-auth_session",
        value: session.id,
        options: expect.objectContaining({ secure: true, path: "/" }),
      },
    ]);
    expect(setCookies[0].options).not.toHaveProperty("domain");
  });

  test("signs in with the __Host- cookie", async () => {
    const auth = loadAuth("production");
    sessions.set("current", { user_id: "user-1", expires_at: inDays(29) });
    cookieHeader = "__Host-auth_session=current";
    const result = await auth.validateRequest();
    expect(result.session?.id).toBe("current");
  });

  test("a deleted account cannot use an existing session", async () => {
    const auth = loadAuth("production");
    sessions.set("current", { user_id: "user-1", expires_at: inDays(30) });
    cookieHeader = "__Host-auth_session=current";
    user.deleted_at = new Date();
    expect(await auth.validateRequest()).toEqual({ user: null, session: null });
  });

  test("a legacy cookie signs no one in and is cleared", async () => {
    const auth = loadAuth("production");
    sessions.set("legacy", { user_id: "user-1", expires_at: inDays(20) });
    cookieHeader = "auth_session=legacy";

    const result = await auth.validateRequest();

    expect(result).toEqual({ user: null, session: null });
    expect(setCookies.map(({ name, value }) => [name, value])).toEqual([
      ["auth_session", ""],
    ]);
  });

  test("while a page renders, a legacy cookie is left alone", async () => {
    const auth = loadAuth("production");
    sessions.set("legacy", { user_id: "user-1", expires_at: inDays(5) });
    cookieHeader = "auth_session=legacy";
    canSet = false;

    expect(await auth.validateRequest()).toEqual({ user: null, session: null });
  });

  test("a legacy cookie next to a __Host- one is ignored", async () => {
    const auth = loadAuth("production");
    sessions.set("current", { user_id: "user-1", expires_at: inDays(29) });
    sessions.set("attacker", { user_id: "user-2", expires_at: inDays(20) });
    cookieHeader = "auth_session=attacker; __Host-auth_session=current";

    const result = await auth.validateRequest();

    expect(result.session?.id).toBe("current");
    expect(setCookies.map(({ name, value }) => [name, value])).toEqual([
      ["auth_session", ""],
    ]);
  });
});

describe("development session cookie", () => {
  test("keeps the plain name over http, where __Host- can't be set", async () => {
    const auth = loadAuth("development");
    sessions.set("dev", { user_id: "user-1", expires_at: inDays(29) });
    cookieHeader = "auth_session=dev";

    const result = await auth.validateRequest();
    await auth.setSessionCookie(result.session!);

    expect(result.session?.id).toBe("dev");
    expect(setCookies).toEqual([
      {
        name: "auth_session",
        value: "dev",
        options: expect.objectContaining({ secure: false }),
      },
    ]);
  });
});

describe("an operator's view as another account", () => {
  test("lasts an hour and is never extended", async () => {
    const auth = loadAuth("production");
    sessions.set("operator", { user_id: "user-1", expires_at: inDays(29) });
    const session = await auth.createImpersonationSession("user-2", "operator");
    expect(session.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      3_600_000,
    );
    cookieHeader = `__Host-auth_session=${session.id}`;

    const result = await auth.validateRequest();

    expect(result.session).toMatchObject({
      id: session.id,
      fresh: false,
      impersonatorSessionId: "operator",
    });
    expect(sessions.get(session.id)?.expires_at).toEqual(session.expiresAt);
    expect(setCookies).toEqual([]);
  });

  test("ends by signing the operator back into their own session", async () => {
    const auth = loadAuth("production");
    sessions.set("operator", { user_id: "user-1", expires_at: inDays(29) });
    const session = await auth.createImpersonationSession("user-2", "operator");

    const operator = await auth.endImpersonation(session);

    expect(operator?.id).toBe("user-1");
    expect(sessions.has(session.id)).toBe(false);
    expect(setCookies.map(({ name, value }) => [name, value])).toEqual([
      ["__Host-auth_session", "operator"],
    ]);
  });

  test("ends signed out when the operator's session is gone", async () => {
    const auth = loadAuth("production");
    const session = await auth.createImpersonationSession("user-2", "gone");

    expect(await auth.endImpersonation(session)).toBeNull();
    expect(setCookies.map(({ name, value }) => [name, value])).toEqual([
      ["__Host-auth_session", ""],
    ]);
  });
});
