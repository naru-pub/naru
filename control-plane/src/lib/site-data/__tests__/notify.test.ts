/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import {
  answerOf,
  callSiteObject,
  requestWorker,
  siteDataWorker,
} from "@/lib/edge/client";

// ctx.notify end to end in the site's object (scripts/with-edge-worker.sh):
// a mutation queues in _naru_notify_outbox with its transaction, the Worker
// lists the site as pending, and the control plane's job reads and
// acknowledges it (lib/app-api/delivery.ts).
const integration =
  process.env.NARU_DATA_TEST === "1" ? describe : describe.skip;

const site = "notifysite";
const ownerId = "0190f5a0-0000-7000-8000-0000000000ab";
const member = "0199f2a4-7c1e-7d3a-9b2f-1a2b3c4d5e6f";
const call = (name: string, args: unknown = null) =>
  callSiteObject<{ result: unknown }>(site, "call", {
    ownerId,
    site,
    member: null,
    kind: "mutation",
    file: "board",
    name,
    args,
  }).then((answer) => answer.result);
const pending = async () =>
  (
    await answerOf<{ sites: string[] }>(
      await requestWorker(siteDataWorker(), "/v1/notifications/pending", "pending", {
        body: "{}",
        contentType: "application/json",
      }),
      "pending",
    )
  ).sites;
type Row = { id: string; members: string[]; title: string; body: string; path: string };
const outbox = () => callSiteObject<Row[]>(site, "notifyOutbox", { limit: 100 });

integration("ctx.notify", () => {
  test("queues with the mutation's transaction, until delivered", async () => {
    await callSiteObject(site, "erase", {});
    await callSiteObject(site, "putFunctions", {
      site,
      folder: "mutations",
      file: "board",
      source: `
export async function reply(ctx, { to }) {
  await ctx.notify([to], { title: "새 댓글", body: "안녕하세요", path: "/posts/1" });
  return "ok";
}
export async function regret(ctx, { to }) {
  await ctx.notify([to], { title: "보내지 않을 알림" });
  ctx.fail("CONFLICT", "그만둡니다.");
}
export async function elsewhere(ctx, { to }) {
  await ctx.notify([to], { title: "t", path: "https://evil.example/" });
}`,
      publish: true,
    });

    expect(await call("reply", { to: member })).toBe("ok");
    expect(await pending()).toContain(site);
    expect(await outbox()).toMatchObject([
      { members: [member], title: "새 댓글", body: "안녕하세요", path: "/posts/1" },
    ]);

    // A call that fails sends nothing; nor does one naming another address.
    await expect(call("regret", { to: member })).rejects.toThrow("그만둡니다.");
    await expect(call("elsewhere", { to: member })).rejects.toThrow(/path/);
    const rows = await outbox();
    expect(rows).toHaveLength(1);

    // Acknowledged: the outbox is empty and the site is no longer pending.
    expect(
      await callSiteObject(site, "ackNotifyOutbox", { ids: rows.map((row) => row.id) }),
    ).toEqual({ pending: 0 });
    expect(await outbox()).toEqual([]);
    expect(await pending()).not.toContain(site);
  });
});
