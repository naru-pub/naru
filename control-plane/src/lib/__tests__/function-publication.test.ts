/** @jest-environment node */
import { jest, test, expect, beforeEach } from "@jest/globals";
jest.mock("@/lib/site-functions/releases", () => ({
  publishSiteFunctions: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
const { publishSiteFunctions } = jest.requireMock<
  typeof import("@/lib/site-functions/releases")
>("@/lib/site-functions/releases");
const { purgeSiteFiles, purgeSiteObjects } =
  jest.requireActual<typeof import("@/lib/cache-purge")>("@/lib/cache-purge");
const publish = jest.mocked(publishSiteFunctions);
beforeEach(() => {
  publish.mockReset();
  publish.mockResolvedValue({ revision: "one" });
});

test("bulk edits publish once per affected site, including deleted nested keys", async () => {
  await purgeSiteObjects([
    "alice/_naru/functions/a.js",
    "alice/_naru/modules/nested/b.js",
    "bob/_naru/functions/a.js",
    "carol/app.js",
  ]);
  expect(publish.mock.calls).toEqual([["alice"], ["bob"]]);
});
test("file editor preserves the directory when activating its site", async () => {
  await purgeSiteFiles("alice", ["_naru/modules/shared.js"]);
  expect(publish).toHaveBeenCalledWith("alice");
});
test("ordinary frontend changes need no function publication", async () => {
  await purgeSiteFiles("alice", ["index.html", "_naru/README.md"]);
  expect(publish).not.toHaveBeenCalled();
});
test("collection rules publish like functions, since they run from revisions", async () => {
  await purgeSiteFiles("alice", ["_naru/rules/auth.js"]);
  expect(publish).toHaveBeenCalledWith("alice");
});
test("publication failures reach the caller so saves cannot report activation", async () => {
  publish.mockRejectedValue(new Error("Missing import"));
  await expect(
    purgeSiteFiles("alice", ["_naru/functions/a.js"]),
  ).rejects.toThrow("Missing import");
});

test("a site change is purged at once and again after reads in flight have stored", async () => {
  jest.useFakeTimers();
  const environment = { ...process.env };
  Object.assign(process.env, {
    CLOUDFLARE_ZONE_ID: "zone",
    CLOUDFLARE_USER_API_TOKEN: "token",
    NEXT_PUBLIC_DOMAIN: "naru.pub",
  });
  const purged: string[][] = [];
  const original = global.fetch;
  global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    purged.push(JSON.parse(String(init?.body)).files);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await purgeSiteFiles("alice", ["app/shop.js"]);
    expect(purged).toHaveLength(1);
    expect(purged[0]).toContain("https://alice.naru.pub/app%2Fshop.js");
    const { REPURGE_AFTER_MS } =
      jest.requireActual<typeof import("@/lib/cache-purge")>(
        "@/lib/cache-purge",
      );
    await jest.advanceTimersByTimeAsync(REPURGE_AFTER_MS);
    expect(purged).toEqual([purged[0], purged[0]]);
  } finally {
    global.fetch = original;
    process.env = environment;
    jest.useRealTimers();
  }
});
