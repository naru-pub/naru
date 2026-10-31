import { randomUUID } from "crypto";
import { sql } from "kysely";
import { db } from "@/lib/database";
import type { User } from "@/lib/auth";
import { BoardError } from "@/lib/board/board-error";
import { enqueueJob } from "@/lib/payments/payment-jobs";
import { newOrderId } from "@/lib/payments/toss";
import { marketFee, REFUND_WINDOW_DAYS } from "./constants";

// Buying a template: the browser opens Toss's payment window on the market
// MID for an order 나루 made (prepare), Toss sends the buyer back with a
// paymentKey (accept), and an Absurd task approves it (market-jobs). The
// amount is always the one 나루 recorded, never the browser's.

// Open orders a buyer may have at once, and how long an order Toss never
// saw stays open: Toss's payment window gives up well before.
const MAX_OPEN_ORDERS = 10;
export const UNCONFIRMED_ORDER_MS = 45 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PreparedPurchase {
  orderId: string;
  amount: number;
  orderName: string;
  customerKey: string;
}

async function customerKeyOf(userId: string): Promise<string> {
  const row = await db
    .selectFrom("users")
    .select("toss_customer_key")
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  if (row.toss_customer_key) return row.toss_customer_key;
  const key = randomUUID();
  const updated = await db
    .updateTable("users")
    .set({ toss_customer_key: key })
    .where("id", "=", userId)
    .where("toss_customer_key", "is", null)
    .returning("toss_customer_key")
    .executeTakeFirst();
  return updated?.toss_customer_key ?? (await customerKeyOf(userId));
}

// Step 1: an order for the template at its price now.
export async function prepareTemplatePurchase(
  user: User,
  templateId: string,
): Promise<PreparedPurchase> {
  if (!user.emailVerifiedAt) {
    throw new BoardError(403, "템플릿을 사려면 먼저 이메일을 인증해 주세요.");
  }
  const template = await db
    .selectFrom("board_templates as t")
    .innerJoin("board_posts as p", "p.id", "t.post_id")
    .leftJoin("market_sellers as s", (join) =>
      join.onRef("s.user_id", "=", "t.user_id").on("s.deleted_at", "is", null),
    )
    .select([
      "t.id",
      "t.user_id",
      "t.price",
      "t.latest_version_id",
      "p.title",
      "s.id as seller_id",
      "s.toss_seller_id",
    ])
    .where("t.id", "=", templateId)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!template?.latest_version_id) {
    throw new BoardError(404, "템플릿을 찾을 수 없습니다.");
  }
  if (template.price === 0) {
    throw new BoardError(400, "무료 템플릿이에요.");
  }
  if (template.user_id === user.id) {
    throw new BoardError(400, "내 템플릿은 사지 않아도 적용할 수 있어요.");
  }
  if (!template.seller_id || !template.toss_seller_id) {
    throw new BoardError(409, "지금은 이 템플릿을 팔지 않아요.");
  }
  // A purchase being refunded still holds the one done row a buyer may have
  // of a template (template_purchases_one_done_idx).
  const owned = await db
    .selectFrom("template_purchases")
    .select("refund_requested_at")
    .where("buyer_id", "=", user.id)
    .where("template_id", "=", template.id)
    .where("status", "=", "done")
    .executeTakeFirst();
  if (owned) {
    throw new BoardError(
      409,
      owned.refund_requested_at
        ? "환불을 처리하고 있어요. 끝난 뒤에 다시 살 수 있어요."
        : "이미 산 템플릿이에요.",
    );
  }
  // Each order is one Toss lookup later; a script hammering this would
  // multiply them.
  const open = await db
    .selectFrom("template_purchases")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("buyer_id", "=", user.id)
    .where("status", "=", "pending")
    .where("created_at", ">", new Date(Date.now() - UNCONFIRMED_ORDER_MS))
    .executeTakeFirstOrThrow();
  if (Number(open.count) >= MAX_OPEN_ORDERS) {
    throw new BoardError(
      429,
      "결제 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    );
  }

  const customerKey = await customerKeyOf(user.id);
  const orderName = `나루 템플릿: ${template.title}`.slice(0, 100);
  for (let tries = 1; ; tries++) {
    const orderId = `T${newOrderId()}`;
    try {
      await db
        .insertInto("template_purchases")
        .values({
          template_id: template.id,
          buyer_id: user.id,
          seller_id: template.seller_id,
          template_title: template.title,
          order_id: orderId,
          amount: template.price,
          fee: marketFee(template.price),
        })
        .execute();
      return { orderId, amount: template.price, orderName, customerKey };
    } catch (error) {
      const { code, constraint } = (error ?? {}) as {
        code?: string;
        constraint?: string;
      };
      if (
        tries >= 3 ||
        code !== "23505" ||
        constraint !== "template_purchases_order_id_key"
      )
        throw error;
    }
  }
}

// Step 2: the buyer authenticated the payment. Only the task approves it.
export async function acceptTemplatePurchase(
  user: User,
  input: { orderId: unknown; paymentKey: unknown; amount: unknown },
): Promise<{ purchaseId: string; templateId: string | null; done: boolean }> {
  const { orderId, paymentKey, amount } = input;
  if (
    typeof orderId !== "string" ||
    !orderId ||
    orderId.length > 64 ||
    typeof paymentKey !== "string" ||
    !paymentKey.trim() ||
    paymentKey.length > 200 ||
    typeof amount !== "number"
  ) {
    throw new BoardError(400, "유효하지 않은 요청입니다.");
  }
  return db.transaction().execute(async (trx) => {
    const purchase = await trx
      .selectFrom("template_purchases")
      .selectAll()
      .where("order_id", "=", orderId)
      .where("buyer_id", "=", user.id)
      .forUpdate()
      .executeTakeFirst();
    if (!purchase) throw new BoardError(404, "결제 주문을 찾을 수 없습니다.");
    if (purchase.toss_payment_key && purchase.toss_payment_key !== paymentKey) {
      throw new BoardError(409, "결제 승인 정보가 주문과 맞지 않습니다.");
    }
    const result = {
      purchaseId: purchase.id,
      templateId: purchase.template_id,
    };
    if (purchase.status === "done") return { ...result, done: true };
    if (purchase.status !== "pending" || amount !== purchase.amount) {
      throw new BoardError(400, "결제 주문 정보가 올바르지 않습니다.");
    }
    await trx
      .updateTable("template_purchases")
      .set({ toss_payment_key: paymentKey })
      .where("id", "=", purchase.id)
      .execute();
    await enqueueJob(
      trx,
      { kind: "confirm_template_purchase", purchaseId: purchase.id },
      { dedupeKey: `template-purchase-confirm:${purchase.id}` },
    );
    return { ...result, done: false };
  });
}

export interface PurchaseSummary {
  id: string;
  // Null once the template's author deleted their account.
  templateId: string | null;
  postId: string | null;
  title: string;
  amount: number;
  status: string;
  createdAt: Date;
  paidAt: Date | null;
  receiptUrl: string | null;
  refundable: boolean;
}

export async function getPurchase(user: User, purchaseId: string) {
  const [purchase] = await listPurchases(user, purchaseId);
  if (!purchase) throw new BoardError(404, "구매 내역을 찾을 수 없습니다.");
  return purchase;
}

// What the buyer bought, newest first, with whether each can be refunded.
export async function listPurchases(
  user: User,
  purchaseId?: string,
): Promise<PurchaseSummary[]> {
  let query = db
    .selectFrom("template_purchases as tp")
    .leftJoin("board_templates as t", "t.id", "tp.template_id")
    .leftJoin("board_posts as p", (join) =>
      join.onRef("p.id", "=", "t.post_id").on("p.deleted_at", "is", null),
    )
    .select([
      "tp.id",
      "tp.template_id",
      "p.id as post_id",
      "tp.template_title",
      "tp.amount",
      "tp.status",
      "tp.created_at",
      "tp.paid_at",
      "tp.toss_receipt_url",
      "tp.payout_id",
      "tp.refund_requested_at",
    ])
    .where("tp.buyer_id", "=", user.id)
    .where("tp.status", "in", ["pending", "done", "canceled"])
    .orderBy("tp.created_at", "desc")
    .limit(200);
  if (purchaseId) query = query.where("tp.id", "=", purchaseId);
  const rows = await query.execute();
  const applied = await appliedSincePurchase(
    user.id,
    rows.filter((row) => row.status === "done").map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    templateId: row.template_id,
    postId: row.post_id,
    title: row.template_title,
    amount: row.amount,
    status: row.status,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    receiptUrl: row.toss_receipt_url,
    refundable:
      row.status === "done" &&
      !row.payout_id &&
      !row.refund_requested_at &&
      !applied.has(row.id) &&
      withinRefundWindow(row.paid_at),
  }));
}

function withinRefundWindow(paidAt: Date | string | null): boolean {
  return (
    paidAt !== null &&
    Date.now() - new Date(paidAt).getTime() < REFUND_WINDOW_DAYS * DAY_MS
  );
}

// The purchases whose template the buyer applied after buying it: used
// digital content is not withdrawn.
async function appliedSincePurchase(
  userId: string,
  purchaseIds: string[],
): Promise<Set<string>> {
  if (purchaseIds.length === 0) return new Set();
  const rows = await db
    .selectFrom("template_purchases as tp")
    .select("tp.id")
    .where("tp.id", "in", purchaseIds)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom("board_template_applications as a")
          .innerJoin("board_template_versions as v", "v.id", "a.version_id")
          .select(sql`1`.as("one"))
          .whereRef("v.template_id", "=", "tp.template_id")
          .where("a.user_id", "=", userId)
          .whereRef("a.created_at", ">=", "tp.paid_at"),
      ),
    )
    .execute();
  return new Set(rows.map((row) => row.id));
}

// A refund the buyer asked for: within the window, never applied, not yet
// paid out to the seller. The task cancels the payment at Toss.
export async function requestTemplateRefund(
  user: User,
  purchaseId: string,
): Promise<void> {
  const purchase = await getPurchase(user, purchaseId);
  if (!purchase.refundable) {
    throw new BoardError(
      409,
      `구매 후 ${REFUND_WINDOW_DAYS}일 안에, 적용하기 전에만 환불할 수 있어요.`,
    );
  }
  await db.transaction().execute(async (trx) => {
    // The payout run takes the same row lock before it claims a purchase.
    const locked = await trx
      .selectFrom("template_purchases")
      .select(["status", "payout_id"])
      .where("id", "=", purchaseId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (locked.status !== "done" || locked.payout_id) {
      throw new BoardError(409, "환불할 수 없는 구매입니다.");
    }
    // Held out of payouts until the refund settles.
    await trx
      .updateTable("template_purchases")
      .set({ refund_requested_at: new Date() })
      .where("id", "=", purchaseId)
      .execute();
    await enqueueJob(
      trx,
      { kind: "refund_template_purchase", purchaseId },
      { dedupeKey: `template-purchase-refund:${purchaseId}` },
    );
  });
}
