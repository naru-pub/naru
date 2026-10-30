import { db } from "@/lib/database";
import type { User } from "@/lib/auth";
import { BoardError } from "@/lib/board/board-error";
import {
  isTemplatePrice,
  MAX_TEMPLATE_PRICE,
  MIN_TEMPLATE_PRICE,
} from "./constants";
import { canSell } from "./sellers";

// The author puts a price on a template, or takes it off. A price takes a
// seller registered at Toss, who is paid out what it sells for. Whoever
// bought or applied it before keeps it and its updates (access.ts).
export async function setTemplatePrice(
  user: User,
  templateId: string,
  price: unknown,
): Promise<number> {
  if (!isTemplatePrice(price)) {
    throw new BoardError(
      400,
      `가격은 0원(무료)이거나 ${MIN_TEMPLATE_PRICE.toLocaleString("ko-KR")}원에서 ${MAX_TEMPLATE_PRICE.toLocaleString("ko-KR")}원 사이, 100원 단위로 정해 주세요.`,
    );
  }
  const template = await db
    .selectFrom("board_templates as t")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .select(["t.id", "t.user_id"])
    .where("t.id", "=", templateId)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!template) throw new BoardError(404, "템플릿을 찾을 수 없습니다.");
  if (template.user_id !== user.id) {
    throw new BoardError(403, "내 템플릿의 가격만 바꿀 수 있어요.");
  }
  if (price > 0 && !(await canSell(user.id))) {
    throw new BoardError(
      409,
      "유료로 팔려면 먼저 판매자 정산 정보를 등록해 주세요.",
    );
  }
  await db
    .updateTable("board_templates")
    .set({ price })
    .where("id", "=", template.id)
    .execute();
  return price;
}
