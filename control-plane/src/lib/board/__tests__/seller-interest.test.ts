/** @jest-environment node */
import { afterAll, describe, expect, test } from "@jest/globals";
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
