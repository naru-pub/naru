import { db } from "@/lib/database";
import type { User } from "@/lib/auth";
import { BoardError } from "./errors";
import {
  MAX_SELLER_INTEREST_LENGTH,
  SELLER_INTEREST_PRICES,
  type SellerInterestPrice,
} from "./seller-interest-options";

// Who would like to sell templates, once that exists. Only a question for
// now: nothing here lets anyone sell. Operators read the answers at
// /admin/seller-interest and reach people by their account's email.

function isPrice(value: unknown): value is SellerInterestPrice {
  return (
    typeof value === "string" && Object.hasOwn(SELLER_INTEREST_PRICES, value)
  );
}

export async function findSellerInterest(userId: string) {
  return await db
    .selectFrom("template_seller_interest")
    .select(["description", "price_range"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
}

// One answer per person: sending it again changes it.
export async function saveSellerInterest(
  user: User,
  input: { description: unknown; priceRange: unknown },
): Promise<void> {
  const description =
    typeof input.description === "string" ? input.description.trim() : "";
  if (!description || description.length > MAX_SELLER_INTEREST_LENGTH) {
    throw new BoardError(
      400,
      `어떤 템플릿인지 ${MAX_SELLER_INTEREST_LENGTH}자 안으로 적어 주세요.`,
    );
  }
  if (!isPrice(input.priceRange)) {
    throw new BoardError(400, "생각하는 가격을 골라 주세요.");
  }
  const values = { description, price_range: input.priceRange };
  await db
    .insertInto("template_seller_interest")
    .values({ user_id: user.id, ...values })
    .onConflict((oc) =>
      oc.column("user_id").doUpdateSet({ ...values, updated_at: new Date() }),
    )
    .execute();
}
