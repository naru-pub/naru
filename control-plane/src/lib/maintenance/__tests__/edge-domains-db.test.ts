/** @jest-environment node */
import { afterAll, describe, expect, jest, test } from "@jest/globals";
import { sql } from "kysely";
import { db } from "@/lib/database";

// The Worker stands in, keeping the custom domain tables it is sent.
const tables: {
  confirmedUntil: number;
  domains: Record<
    string,
    { login: string; entitledUntil: number | null; redirect: boolean }
  >;
  suspended: string[];
}[] = [];
jest.mock("@/lib/edge/client", () => ({
  CONFIRMATION_MS: 60_000,
  replaceEdgeDomains: async (table: (typeof tables)[number]) => {
    tables.push(table);
    return null;
  },
}));
const { pushEdgeDomains, servedCustomDomains } =
  require("@/lib/edge/domains") as typeof import("@/lib/edge/domains");
const { checkCustomDomainDns } =
  require("@/lib/edge/domain-dns") as typeof import("@/lib/edge/domain-dns");

const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

integration("edge custom domains", () => {
  afterAll(async () => {
    await db.destroy();
  });

  test("sends every active domain of a paid-up owner, until the grace period ends", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const paid = now + day;
    const users: string[] = [];
    const user = async (login: string, comp: boolean, until: number | null) => {
      const { id } = await db
        .insertInto("users")
        .values({
          login_name: login,
          password_hash: "x",
          supporter_comp: comp,
          supporter_until: until === null ? null : new Date(until),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      users.push(id);
      return id;
    };
    const domain = (host: string, userId: string, active = true) =>
      sql`insert into custom_domains (user_id, hostname, cloudflare_hostname_id,
            cloudflare_status, ssl_status, verified_at)
          values (${userId}, ${host}, ${`cf-${host}`}, ${active ? "active" : "pending"},
            ${active ? "active" : "pending_validation"}, ${active ? new Date() : null})`.execute(
        db,
      );
    try {
      await domain("comp.example", await user("edge-comp", true, null));
      const paidUser = await user("edge-paid", false, paid);
      await domain("paid.example", paidUser);
      await domain(
        "grace.example",
        await user("edge-grace", false, now - 2 * day),
      );
      const expired = await user("edge-expired", false, now - 10 * day);
      await domain("expired.example", expired);
      const pending = await user("edge-pending", false, paid);
      await domain("pending.example", pending, false);

      expect(await pushEdgeDomains()).toBe(3);
      const table = tables.at(-1)!;
      expect(table.confirmedUntil).toBeGreaterThan(now);
      expect(table.domains).toEqual({
        "comp.example": {
          login: "edge-comp",
          entitledUntil: null,
          redirect: false,
        },
        "grace.example": {
          login: "edge-grace",
          entitledUntil: expect.any(Number),
          redirect: false,
        },
        "paid.example": {
          login: "edge-paid",
          entitledUntil: expect.any(Number),
          redirect: false,
        },
      });
      // Four days of grace after the last paid day.
      expect(
        Math.round((table.domains["paid.example"].entitledUntil! - paid) / day),
      ).toBe(4);
      expect(table.suspended).toEqual([]);
      // One owner's served domain, as the prompt shows it.
      expect(
        (await servedCustomDomains(paidUser)).map((d) => d.hostname),
      ).toEqual(["paid.example"]);
      expect(await servedCustomDomains(expired)).toEqual([]);
      expect(await servedCustomDomains(pending)).toEqual([]);
      // A suspended site is listed, for the edge to refuse on every host.
      await db
        .updateTable("users")
        .set({ site_moderation: "suspended" })
        .where("login_name", "=", "edge-paid")
        .execute();
      await pushEdgeDomains();
      expect(tables.at(-1)!.suspended).toEqual(["edge-paid"]);
    } finally {
      await db.deleteFrom("users").where("id", "in", users).execute();
    }
  });
  test("redirects to a domain only once its DNS reaches the target", async () => {
    const users: string[] = [];
    // An account has one domain: one account each.
    const insert = async (host: string) => {
      const { id } = await db
        .insertInto("users")
        .values({
          login_name: `edge-dns-${users.length}`,
          password_hash: "x",
          supporter_comp: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      users.push(id);
      await db
        .insertInto("custom_domains")
        .values({
          user_id: id,
          hostname: host,
          cloudflare_hostname_id: `cf-${host}`,
          cloudflare_status: "active",
          ssl_status: "active",
          verified_at: new Date(),
        })
        .execute();
    };
    const target = ["104.21.58.28", "172.67.198.242"];
    const answers: Record<string, string[] | null> = {
      "customers.naru.pub": target,
      "alias.example": ["172.67.198.242"],
      "missing.example": [],
      "elsewhere.example": ["192.0.2.1"],
      "timeout.example": null,
      // On its owner's own Cloudflare zone, proxied here: that zone's
      // addresses, but it serves the site.
      "proxied.example": ["198.51.100.7"],
    };
    const looked: string[] = [];
    const lookup = async (host: string) => {
      looked.push(host);
      return answers[host] ?? null;
    };
    const probed: string[] = [];
    const probe = async (host: string, login: string) => {
      probed.push(host);
      return host === "proxied.example" && login.startsWith("edge-dns-");
    };
    const state = async () =>
      Object.fromEntries(
        (
          await db
            .selectFrom("custom_domains")
            .select(["hostname", "dns_resolves", "dns_checked_at"])
            .where("user_id", "in", users)
            .execute()
        ).map((row) => [
          row.hostname,
          { resolves: row.dns_resolves, checked: row.dns_checked_at !== null },
        ]),
      );
    try {
      for (const host of Object.keys(answers).slice(1)) await insert(host);

      expect(await checkCustomDomainDns(lookup, probe)).toBe(4);
      // Only domains with someone else's addresses are asked over HTTPS.
      expect(probed.sort()).toEqual(["elsewhere.example", "proxied.example"]);
      expect(await state()).toEqual({
        "alias.example": { resolves: true, checked: true },
        "missing.example": { resolves: false, checked: true },
        "elsewhere.example": { resolves: false, checked: true },
        "proxied.example": { resolves: true, checked: true },
        // No answer: nothing is recorded, and it is asked again next run.
        "timeout.example": { resolves: false, checked: false },
      });
      await pushEdgeDomains();
      expect(tables.at(-1)!.domains["alias.example"].redirect).toBe(true);
      expect(tables.at(-1)!.domains["missing.example"].redirect).toBe(false);

      // A resolving domain waits an hour; the others are asked every run.
      looked.length = 0;
      await checkCustomDomainDns(lookup, probe);
      expect(looked).not.toContain("alias.example");
      expect(looked).toEqual(
        expect.arrayContaining([
          "missing.example",
          "elsewhere.example",
          "timeout.example",
        ]),
      );

      // Records added: it redirects from the next run.
      answers["missing.example"] = ["104.21.58.28"];
      await checkCustomDomainDns(lookup, probe);
      expect((await state())["missing.example"].resolves).toBe(true);

      // Without the target's addresses nothing changes.
      answers["customers.naru.pub"] = null;
      answers["elsewhere.example"] = target;
      expect(await checkCustomDomainDns(lookup, probe)).toBe(0);
      expect((await state())["elsewhere.example"].resolves).toBe(false);
    } finally {
      await db.deleteFrom("users").where("id", "in", users).execute();
    }
  });
});
