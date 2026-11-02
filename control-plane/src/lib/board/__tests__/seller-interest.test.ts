/** @jest-environment node */
import { afterAll, afterEach, describe, expect, jest, test } from "@jest/globals";
import type { User } from "@/lib/auth";
import { db, pool } from "@/lib/database";
import { findSellerInterest, saveSellerInterest } from "../seller-interest";

const integration =
  process.env.NARU_BOARD_TEST === "1" ? describe : describe.skip;

integration("template seller interest", () => {
  afterAll(async () => {
    await pool.end();
  });

  async function makeUser(loginName: string) {
    const row = await db
      .insertInto("users")
      .values({ login_name: loginName, password_hash: "x" })
      .returning(["id", "login_name"])
      .executeTakeFirstOrThrow();
    return { id: row.id, loginName: row.login_name } as User;
  }

  test("one answer per person, which goes with their account", async () => {
    const user = await makeUser("seller-interest");
    await saveSellerInterest(user, {
      description: "  레트로 홈페이지  ",
      priceRange: "10k_30k",
    });
    await saveSellerInterest(user, {
      description: "방명록",
      priceRange: "unsure",
    });
    expect(await findSellerInterest(user.id)).toEqual({
      description: "방명록",
      price_range: "unsure",
    });

    await db.deleteFrom("users").where("id", "=", user.id).execute();
    expect(await findSellerInterest(user.id)).toBeUndefined();
  });

  describe("the operators' Discord", () => {
    const webhook = "https://discord.test/webhook";

    function postedContent(fetchSpy: jest.SpiedFunction<typeof fetch>) {
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(webhook);
      return JSON.parse(String(init?.body)).content as string;
    }

    afterEach(() => {
      delete process.env.OPERATOR_DISCORD_WEBHOOK_URL;
      jest.restoreAllMocks();
    });

    test("hears of an answer, cut short when it is long", async () => {
      process.env.OPERATOR_DISCORD_WEBHOOK_URL = webhook;
      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValue(new Response(null, { status: 204 }));
      const user = await makeUser("seller-interest-3");

      await saveSellerInterest(user, {
        description: "가".repeat(2000),
        priceRange: "10k_30k",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const content = postedContent(fetchSpy);
      expect(content).toContain("seller-interest-3");
      expect(content).toContain("1만~3만 원");
      expect(content).toContain("가".repeat(1000));
      expect(content).not.toContain("가".repeat(1001));
      expect(content).toContain("/admin/seller-interest");
    });

    test("being down does not lose the answer", async () => {
      process.env.OPERATOR_DISCORD_WEBHOOK_URL = webhook;
      jest.spyOn(global, "fetch").mockRejectedValue(new Error("down"));
      jest.spyOn(console, "error").mockImplementation(() => {});
      const user = await makeUser("seller-interest-4");

      await saveSellerInterest(user, {
        description: "방명록",
        priceRange: "unsure",
      });

      expect(await findSellerInterest(user.id)).toEqual({
        description: "방명록",
        price_range: "unsure",
      });
    });
  });

  test("an empty, overlong or unknown answer is refused", async () => {
    const user = await makeUser("seller-interest-2");
    const save = (description: unknown, priceRange: unknown) =>
      saveSellerInterest(user, { description, priceRange });
    await expect(save("  ", "unsure")).rejects.toThrow("어떤 템플릿");
    await expect(save("가".repeat(2001), "unsure")).rejects.toThrow(
      "어떤 템플릿",
    );
    await expect(save("방명록", "free")).rejects.toThrow("가격");
    await expect(save("방명록", "toString")).rejects.toThrow("가격");
    expect(await findSellerInterest(user.id)).toBeUndefined();
  });
});
