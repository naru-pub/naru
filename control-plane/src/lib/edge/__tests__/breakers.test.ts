/** @jest-environment node */
import { beforeEach, expect, jest, test } from "@jest/globals";
jest.mock("@/lib/edge/client", () => ({
  callSiteObject: jest.fn(),
  requestWorker: jest.fn(),
  answerOf: jest.fn(),
  siteDataWorker: () => ({ base: "http://mini", secret: "s" }),
}));
jest.mock("@/lib/operator-alerts", () => ({
  operatorAlertsConfigured: jest.fn(() => true),
  sendOperatorAlert: jest.fn(),
}));
const client = require("@/lib/edge/client") as jest.Mocked<
  typeof import("@/lib/edge/client")
>;
const alerts = require("@/lib/operator-alerts") as jest.Mocked<
  typeof import("@/lib/operator-alerts")
>;
const { alertBreakerTrips, tripAlert } =
  require("../breakers") as typeof import("../breakers");

const trip = (id: string, text: string | null = "SELECT 1") => ({
  id,
  at: Date.UTC(2026, 9, 18, 3, 0),
  kind: "query" as const,
  file: "posts",
  name: "list",
  key: `query:posts:list:${id}`,
  statement: id,
  text,
  strikes: 3,
  until: Date.UTC(2026, 9, 18, 3, 5),
  repeated: false,
  clearedAt: null,
  notifiedAt: null,
  pausedUntil: null,
});

let trips: Record<string, ReturnType<typeof trip>[]>;
const acked: [string, unknown][] = [];
beforeEach(() => {
  jest.clearAllMocks();
  acked.length = 0;
  trips = { alice: [trip("b"), trip("a", null)], bob: [] };
  client.answerOf.mockResolvedValue({ sites: ["alice", "bob"] });
  client.callSiteObject.mockImplementation((async (
    site: string,
    operation: string,
    input: unknown,
  ) => {
    if (operation === "breakerTrips") return trips[site];
    acked.push([site, input]);
    return { unnotified: 0 };
  }) as typeof client.callSiteObject);
  alerts.operatorAlertsConfigured.mockReturnValue(true);
});

test("each trip is posted once, oldest first, and acknowledged", async () => {
  expect(await alertBreakerTrips()).toEqual({ sites: 2, alerted: 2 });
  expect(client.callSiteObject).toHaveBeenCalledWith("alice", "breakerTrips", {
    unnotified: true,
  });
  expect(
    alerts.sendOperatorAlert.mock.calls.map(([alert]) => alert.lines[1]),
  ).toEqual(["문장은 알 수 없어 함수 전체를 멈춤", "```sql\nSELECT 1\n```"]);
  // A site with none left is acknowledged too, so the Worker forgets it.
  expect(acked).toEqual([
    ["alice", { ids: ["a", "b"] }],
    ["bob", { ids: [] }],
  ]);
});

test("a failed post keeps what was posted and tries the rest again", async () => {
  alerts.sendOperatorAlert
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Discord webhook answered 429"));
  await expect(alertBreakerTrips()).rejects.toThrow(/429/);
  expect(acked).toEqual([["alice", { ids: ["a"] }]]);
});

test("nothing is asked without a webhook", async () => {
  alerts.operatorAlertsConfigured.mockReturnValue(false);
  expect(await alertBreakerTrips()).toEqual({ sites: 0, alerted: 0 });
  expect(client.requestWorker).not.toHaveBeenCalled();
});

test("a trip's message names the site, the function and the pause", () => {
  const alert = tripAlert("alice", { ...trip("a"), repeated: true });
  expect(alert.title).toBe("사이트 SQL 일시 중지: alice");
  expect(alert.lines[0]).toMatch(
    /^쿼리 posts:list — 1분 안에 3번 3초를 넘겨 중지되어 .+까지 5분 멈춤 \(1시간 안에 다시\)$/,
  );
});
