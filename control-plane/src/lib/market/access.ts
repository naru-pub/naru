import { sql } from "kysely";
import { db } from "@/lib/database";
import { BoardError } from "@/lib/board/board-error";

// Who may use a paid template. Apart from purchases.ts so the board (and the
// jobs image's template updates) need nothing of the payment code.

// A purchase that is paid and kept: one whose refund is asked for no longer
// counts, so the template can't be applied while the money goes back.
export async function hasPurchased(
  userId: string,
  templateId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("template_purchases")
    .select("id")
    .where("buyer_id", "=", userId)
    .where("template_id", "=", templateId)
    .where("status", "=", "done")
    .where("refund_requested_at", "is", null)
    .executeTakeFirst();
  return !!row;
}

// Who may apply a template or update to a version of it: anyone while it
// is free, its author, whoever bought it, and whoever applied it before it
// had a price. An application made under a purchase since refunded doesn't
// count: that one ended with the purchase.
export async function canUseTemplate(
  userId: string,
  template: { id: string; user_id: string; price: number },
): Promise<boolean> {
  if (template.price === 0 || template.user_id === userId) return true;
  if (await hasPurchased(userId, template.id)) return true;
  const applied = await db
    .selectFrom("board_template_applications as a")
    .innerJoin("board_template_versions as v", "v.id", "a.version_id")
    .select("a.id")
    .where("a.user_id", "=", userId)
    .where("v.template_id", "=", template.id)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("template_purchases as tp")
            .select(sql`1`.as("one"))
            .where("tp.buyer_id", "=", userId)
            .where("tp.template_id", "=", template.id)
            .where("tp.status", "in", ["done", "canceled"])
            .whereRef("tp.paid_at", "<=", "a.created_at"),
        ),
      ),
    )
    .executeTakeFirst();
  return !!applied;
}

export async function assertCanUseTemplate(
  userId: string,
  templateId: string,
): Promise<void> {
  const template = await db
    .selectFrom("board_templates")
    .select(["id", "user_id", "price"])
    .where("id", "=", templateId)
    .executeTakeFirst();
  if (!template) throw new BoardError(404, "템플릿을 찾을 수 없습니다.");
  if (!(await canUseTemplate(userId, template))) {
    throw new BoardError(402, "유료 템플릿이에요. 구매한 뒤 적용할 수 있어요.");
  }
}
