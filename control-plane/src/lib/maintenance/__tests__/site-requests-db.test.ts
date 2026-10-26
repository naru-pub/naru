/** @jest-environment node */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { db } from "@/lib/database";

// Cloudflare, held in memory: the analytics answer `counts` for any day, and
// the zone's custom ruleset is `rules`. Discord alerts are collected.
let counts: Record<string, number> = {};
let rules: {
  id: string;
  ref?: string;
  expression: string;
  enabled: boolean;
}[] = [];
let rulesetExists = false;
const alerts: { title: string; lines: string[] }[] = [];
jest.mock("@/lib/operator-alerts", () => ({
  operatorAlertsConfigured: () => true,
  sendOperatorAlert: async (alert: { title: string; lines: string[] }) => {
    alerts.push(alert);
  },
}));

const respond = (result: unknown, status = 200) =>
  new Response(
    JSON.stringify({ success: status < 400, result, data: result }),
    {
      status,
    },
  );
global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (url.endsWith("/graphql"))
    return respond({
      viewer: {
        zones: [
          {
            groups: Object.entries(counts).map(([host, count]) => ({
              count,
              dimensions: { clientRequestHTTPHost: host },
            })),
          },
        ],
      },
    });
  if (url.endsWith("/entrypoint")) {
    if (method === "PUT") {
      rulesetExists = true;
      rules = body.rules.map((rule: any, i: number) => ({
        ...rule,
        id: `r${i}`,
      }));
      return respond({ id: "rs" });
    }
    return rulesetExists ? respond({ id: "rs", rules }) : respond(null, 404);
  }
  const id = url.match(/\/rules\/([^/]+)$/)?.[1];
  if (method === "POST") rules.push({ ...body, id: `r${rules.length + 9}` });
  if (method === "PATCH")
    rules = rules.map((rule) => (rule.id === id ? { ...body, id } : rule));
  if (method === "DELETE") rules = rules.filter((rule) => rule.id !== id);
  return respond({ id: "rs", rules });
}) as typeof fetch;

const { limitSiteRequests, setSiteRequestOverride } =
  require("@/lib/edge/site-requests") as typeof import("@/lib/edge/site-requests");

const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

integration("site request limits", () => {
  const logins = ["srl-busy", "srl-half", "srl-fan", "srl-quiet"];
  const ids: Record<string, string> = {};
  const now = new Date("2026-10-12T12:00:00Z");
  const blockedHosts = () =>
    rules
      .find((rule) => rule.ref === "naru-site-request-limit")
      ?.expression.match(/"[^"]+"/g)
      ?.map((host) => JSON.parse(host)) ?? [];

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_DOMAIN = "naru.pub";
    process.env.CLOUDFLARE_ZONE_ID = "zone";
    process.env.CLOUDFLARE_USER_API_TOKEN = "token";
    process.env.SITE_MONTHLY_PAGE_REQUESTS = "1000";
    for (const login of logins) {
      const user = await db
        .insertInto("users")
        .values({
          login_name: login,
          password_hash: "x",
          supporter_comp: login === "srl-fan",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      ids[login] = user.id;
    }
  });

  beforeEach(() => {
    alerts.length = 0;
  });

  afterAll(async () => {
    await db.deleteFrom("users").where("login_name", "in", logins).execute();
    await db.destroy();
  });

  test("blocks a site past its allowance, warns at half, and tells each once", async () => {
    // Yesterday and today each count this much: 2 × the figures.
    counts = {
      "srl-busy.naru.pub": 300,
      "srl-half.naru.pub": 150,
      "srl-fan.naru.pub": 600,
      "srl-quiet.naru.pub": 10,
      "nobody-here.naru.pub": 9999,
    };
    expect(await limitSiteRequests(now)).toEqual({ counted: true, blocked: 0 });
    expect(blockedHosts()).toEqual([]);
    expect(alerts.flatMap((alert) => alert.lines).sort()).toEqual([
      "srl-busy: 이번 달 요청 절반 넘음 — 600 / 1,000 (60%)",
      "srl-fan: 이번 달 요청 한도 넘음, 서포터라 차단하지 않음 — 1,200 / 1,000 (120%)",
    ]);

    counts["srl-busy.naru.pub"] = 500;
    alerts.length = 0;
    await limitSiteRequests(now);
    expect(blockedHosts()).toEqual(["srl-busy.naru.pub"]);
    expect(alerts.flatMap((alert) => alert.lines)).toEqual([
      "srl-busy: 이번 달 요청 한도 넘음 — 1,000 / 1,000 (100%)",
      "차단: srl-busy.naru.pub",
    ]);

    alerts.length = 0;
    await limitSiteRequests(now);
    expect(alerts).toEqual([]);
  });

  test("an operator's exemption lifts a block and a block override adds one", async () => {
    await setSiteRequestOverride(
      { userId: ids["srl-busy"], login: "srl-busy" },
      { mode: "exempt", reason: "launch week" },
      { id: ids["srl-quiet"], loginName: "srl-quiet" },
      now,
    );
    expect(blockedHosts()).toEqual([]);
    expect(alerts.at(-1)!.lines).toEqual(["차단 해제: srl-busy.naru.pub"]);

    await setSiteRequestOverride(
      { userId: ids["srl-quiet"], login: "srl-quiet" },
      { mode: "block", reason: "abuse" },
      { id: ids["srl-quiet"], loginName: "srl-quiet" },
      now,
    );
    expect(blockedHosts()).toEqual(["srl-quiet.naru.pub"]);

    await setSiteRequestOverride(
      { userId: ids["srl-busy"], login: "srl-busy" },
      null,
      { id: ids["srl-quiet"], loginName: "srl-quiet" },
      now,
    );
    expect(blockedHosts()).toEqual(["srl-busy.naru.pub", "srl-quiet.naru.pub"]);
  });

  test("a new month lifts the allowance's blocks", async () => {
    counts = {};
    await setSiteRequestOverride(
      { userId: ids["srl-quiet"], login: "srl-quiet" },
      null,
      { id: ids["srl-quiet"], loginName: "srl-quiet" },
      now,
    );
    alerts.length = 0;
    // Nov 2: the job counts Nov 1 and 2, which saw nothing.
    await limitSiteRequests(new Date("2026-11-02T12:00:00Z"));
    expect(blockedHosts()).toEqual([]);
    expect(alerts.flatMap((alert) => alert.lines)).toEqual([
      "차단 해제: srl-busy.naru.pub",
    ]);
  });
});
