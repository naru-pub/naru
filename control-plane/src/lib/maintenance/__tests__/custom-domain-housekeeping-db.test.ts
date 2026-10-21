/** @jest-environment node */
import { afterAll, describe, expect, jest, test } from "@jest/globals";
import { db } from "@/lib/database";

// The Worker and the mailer stand in: what the edge is sent is counted, and
// no mail leaves.
const pushes: unknown[] = [];
jest.mock("@/lib/edge/client", () => ({
  CONFIRMATION_MS: 60_000,
  replaceEdgeDomains: async (table: unknown) => {
    pushes.push(table);
    return null;
  },
}));
jest.mock("@/lib/email", () => ({
  ...(jest.requireActual("@/lib/email") as object),
  sendCustomDomainReleaseNoticeEmail: async () => {
    throw new Error("the test passes its own notify");
  },
}));
const { runCustomDomainHousekeeping, releaseSchedule } =
  require("@/lib/custom-domain-housekeeping") as typeof import("@/lib/custom-domain-housekeeping");

const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

describe("release schedule", () => {
  const now = Date.UTC(2026, 9, 21);
  const row = {
    createdAt: new Date(now - 100 * DAY),
    active: true,
    dnsFailingSince: null,
    accessEndsAt: null,
    noticeSentAt: null,
  };

  test("nothing is due for a served domain of a paid-up owner", () => {
    expect(releaseSchedule(row, now)).toBeNull();
    expect(
      releaseSchedule({ ...row, accessEndsAt: now + DAY }, now),
    ).toBeNull();
  });

  test("a lapse comes first, then a pending domain, then DNS", () => {
    const all = {
      ...row,
      active: false,
      dnsFailingSince: new Date(now - DAY),
      accessEndsAt: now - DAY,
    };
    expect(releaseSchedule(all, now)?.reason).toBe("lapsed");
    expect(releaseSchedule({ ...all, accessEndsAt: null }, now)?.reason).toBe(
      "pending",
    );
    expect(
      releaseSchedule({ ...all, accessEndsAt: null, active: true }, now)
        ?.reason,
    ).toBe("dns");
  });

  test("the release is never sooner than seven days after the notice", () => {
    const lapsed = { ...row, accessEndsAt: now - 40 * DAY };
    // Due ten days ago, but told only now.
    expect(releaseSchedule(lapsed, now)?.releaseAt).toBeNull();
    expect(
      releaseSchedule({ ...lapsed, noticeSentAt: new Date(now) }, now)
        ?.releaseAt,
    ).toEqual(new Date(now + 7 * DAY));
    // Told in time: released when due.
    const due = lapsed.accessEndsAt + 30 * DAY;
    expect(
      releaseSchedule({ ...lapsed, noticeSentAt: new Date(due - 8 * DAY) }, now)
        ?.releaseAt,
    ).toEqual(new Date(due));
  });
});

integration("custom domain housekeeping", () => {
  afterAll(async () => {
    await db.destroy();
  });

  test("tells owners, waits the notice out, then releases and purges", async () => {
    const now = Date.now();
    const users: string[] = [];
    const domain = async (
      login: string,
      opts: {
        until?: number | null;
        comp?: boolean;
        active?: boolean;
        createdDaysAgo?: number;
        dnsFailingDaysAgo?: number;
        noticeDaysAgo?: number;
        releasedDaysAgo?: number;
      },
    ) => {
      const { id: userId } = await db
        .insertInto("users")
        .values({
          login_name: `housekeeping-${login}`,
          password_hash: "x",
          supporter_comp: opts.comp ?? false,
          supporter_until:
            opts.until === undefined || opts.until === null
              ? null
              : new Date(opts.until),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      users.push(userId);
      const active = opts.active ?? true;
      const released = opts.releasedDaysAgo !== undefined;
      await db
        .insertInto("custom_domains")
        .values({
          user_id: userId,
          hostname: `${login}.example`,
          cloudflare_hostname_id: released ? null : `cf-${login}`,
          cloudflare_status: released
            ? "released"
            : active
              ? "active"
              : "pending",
          ssl_status: active && !released ? "active" : null,
          verified_at: active && !released ? new Date(now) : null,
          created_at: new Date(now - (opts.createdDaysAgo ?? 100) * DAY),
          dns_failing_since:
            opts.dnsFailingDaysAgo === undefined
              ? null
              : new Date(now - opts.dnsFailingDaysAgo * DAY),
          release_notice_sent_at:
            opts.noticeDaysAgo === undefined
              ? null
              : new Date(now - opts.noticeDaysAgo * DAY),
          released_at: released
            ? new Date(now - opts.releasedDaysAgo! * DAY)
            : null,
          release_reason: released ? "lapsed" : null,
        })
        .execute();
    };
    const paid = now + 30 * DAY;
    try {
      // Paid time ended 40 days ago (with four days' grace): due 6 days ago.
      await domain("lapsed", { until: now - 40 * DAY });
      // Paid up, but told before it paid: the notice is withdrawn.
      await domain("renewed", { until: paid, noticeDaysAgo: 1 });
      await domain("pending", {
        until: paid,
        active: false,
        createdDaysAgo: 20,
      });
      await domain("young", { until: paid, active: false, createdDaysAgo: 3 });
      // Due in five days: told now, released in seven.
      await domain("dns", { until: paid, dnsFailingDaysAgo: 25 });
      await domain("comp", { comp: true, until: null });
      await domain("silent", {
        until: paid,
        active: false,
        createdDaysAgo: 30,
      });
      await domain("bounce", {
        until: paid,
        active: false,
        createdDaysAgo: 30,
      });
      await domain("stuck", { until: paid, active: false, createdDaysAgo: 30 });
      // Released over a year ago: purged.
      await domain("old", { until: null, releasedDaysAgo: 400 });

      const told: string[] = [];
      const notify = async (
        _userId: string,
        notice: { hostname: string; releaseAt: Date },
      ) => {
        if (notice.hostname === "bounce.example") throw new Error("bounced");
        told.push(notice.hostname);
        // No verified address: still counted as told.
        return notice.hostname !== "silent.example";
      };
      const deleted: string[] = [];
      const deleteHostname = async (id: string) => {
        if (id === "cf-stuck") throw new Error("Cloudflare is down");
        deleted.push(id);
      };
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const log = jest.spyOn(console, "log").mockImplementation(() => {});
      try {
        const first = await runCustomDomainHousekeeping({
          now,
          notify,
          deleteHostname,
        });
        expect(told.sort()).toEqual([
          "dns.example",
          "lapsed.example",
          "pending.example",
          "silent.example",
          "stuck.example",
        ]);
        expect(first).toEqual({
          notices: 5,
          withdrawn: 1,
          released: 0,
          purged: 1,
        });
        expect(deleted).toEqual([]);

        // A day short of the notice period: still nothing released.
        expect(
          (
            await runCustomDomainHousekeeping({
              now: now + 6 * DAY,
              notify,
              deleteHostname,
            })
          ).released,
        ).toBe(0);

        const later = await runCustomDomainHousekeeping({
          now: now + 8 * DAY,
          notify,
          deleteHostname,
        });
        // stuck failed at Cloudflare and waits for the next run; bounce's
        // notice keeps failing, so it is never released untold. young came
        // within seven days of its release and is told now.
        expect(later.released).toBe(4);
        expect(deleted.sort()).toEqual([
          "cf-dns",
          "cf-lapsed",
          "cf-pending",
          "cf-silent",
        ]);
        expect(told).not.toContain("bounce.example");
        expect(told).toContain("young.example");
        expect(pushes.length).toBeGreaterThan(0);
      } finally {
        error.mockRestore();
        warn.mockRestore();
        log.mockRestore();
      }

      const rows = await db
        .selectFrom("custom_domains")
        .select([
          "hostname",
          "released_at",
          "release_reason",
          "release_notice_sent_at",
          "cloudflare_hostname_id",
          "cloudflare_status",
        ])
        .where("user_id", "in", users)
        .execute();
      const by = Object.fromEntries(rows.map((row) => [row.hostname, row]));
      expect(by["old.example"]).toBeUndefined();
      for (const [host, reason] of [
        ["lapsed.example", "lapsed"],
        ["pending.example", "pending"],
        ["dns.example", "dns"],
        ["silent.example", "pending"],
      ] as const) {
        expect(by[host]).toMatchObject({
          release_reason: reason,
          release_notice_sent_at: null,
          cloudflare_hostname_id: null,
          cloudflare_status: "released",
        });
        expect(by[host].released_at).not.toBeNull();
      }
      for (const host of [
        "renewed.example",
        "young.example",
        "comp.example",
        "stuck.example",
        "bounce.example",
      ])
        expect(by[host].released_at).toBeNull();
      expect(by["renewed.example"].release_notice_sent_at).toBeNull();
      expect(by["stuck.example"].cloudflare_hostname_id).toBe("cf-stuck");
    } finally {
      await db.deleteFrom("users").where("id", "in", users).execute();
    }
  });
});
