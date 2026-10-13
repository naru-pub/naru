/** @jest-environment node */
import { jest, test, expect, beforeEach } from "@jest/globals";
jest.mock("@/lib/edge/client", () => ({ callSiteObject: jest.fn() }));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
const { callSiteObject } =
  jest.requireMock<typeof import("@/lib/edge/client")>("@/lib/edge/client");
const { purgeSiteFiles, purgeSiteObjects } =
  jest.requireActual<typeof import("@/lib/cache-purge")>("@/lib/cache-purge");
const publish = jest.mocked(callSiteObject);
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
  expect(publish.mock.calls).toEqual([
    ["alice", "publishFunctions", { site: "alice" }],
    ["bob", "publishFunctions", { site: "bob" }],
  ]);
});
test("file editor preserves the directory when activating its site", async () => {
  await purgeSiteFiles("alice", ["_naru/modules/shared.js"]);
  expect(publish).toHaveBeenCalledWith("alice", "publishFunctions", {
    site: "alice",
  });
});
test("ordinary frontend and rule changes need no function publication", async () => {
  await purgeSiteFiles("alice", ["index.html", "_naru/rules/auth.js"]);
  expect(publish).not.toHaveBeenCalled();
});
test("publication failures reach the caller so saves cannot report activation", async () => {
  publish.mockRejectedValue(new Error("Missing import"));
  await expect(
    purgeSiteFiles("alice", ["_naru/functions/a.js"]),
  ).rejects.toThrow("Missing import");
});
