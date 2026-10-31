import { sql } from "kysely";
import { db } from "@/lib/database";
import type { User } from "@/lib/auth";
import { enqueueJob } from "@/lib/payments/payment-jobs";
import {
  cancelPayout,
  getPayout,
  isDefinitiveTossFailure,
  requestPayouts,
  TossApiError,
  type TossPayout,
} from "@/lib/payments/toss";
import {
  MIN_PAYOUT_AMOUNT,
  PAYOUT_DESCRIPTION,
  PAYOUT_HOLD_DAYS,
} from "./constants";
import {
  OPEN_PAYOUT_STATUSES,
  PAYABLE_SELLER_STATUSES,
  type PayoutStatus,
} from "./states";

// Paying sellers through Toss's 지급대행. Once a day (market-payouts), each
// seller Toss pays out to gets one payout for their sales whose refund
// window has closed, at most once a week. A payout row and the purchases it
// covers are written together before Toss is asked, so a crash between the
// two leaves a pending payout its task sends again under the same
// idempotency key. One Toss refuses frees its purchases for the next run:
// a holiday payout date, a balance not yet settled.

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PAYOUT_INTERVAL_DAYS = 7;

// The next weekday after `now` in KST, yyyy-MM-dd: SCHEDULED payouts must
// fall on a business day from tomorrow on. Public holidays are not known
// here; Toss refuses those and the next run picks another day.
export function nextPayoutDate(now: Date): string {
  let day = new Date(now.getTime() + KST_OFFSET_MS + DAY_MS);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) {
    day = new Date(day.getTime() + DAY_MS);
  }
  return day.toISOString().slice(0, 10);
}

/**
 * Records a payout for every seller with sales ready to pay, and queues the
 * task that sends each to Toss. Returns how many it made.
 */
export async function createDuePayouts(now = new Date()): Promise<number> {
  const heldUntil = new Date(now.getTime() - PAYOUT_HOLD_DAYS * DAY_MS);
  const weekAgo = new Date(now.getTime() - PAYOUT_INTERVAL_DAYS * DAY_MS);
  const sellers = await db
    .selectFrom("market_sellers as s")
    .select("s.id")
    .where("s.toss_seller_id", "is not", null)
    .where("s.deleted_at", "is", null)
    .where("s.status", "in", PAYABLE_SELLER_STATUSES)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom("template_purchases as tp")
          .select(sql`1`.as("one"))
          .whereRef("tp.seller_id", "=", "s.id")
          .where("tp.status", "=", "done")
          .where("tp.payout_id", "is", null)
          .where("tp.refund_requested_at", "is", null)
          .where("tp.paid_at", "<=", heldUntil),
      ),
    )
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("seller_payouts as sp")
            .select(sql`1`.as("one"))
            .whereRef("sp.seller_id", "=", "s.id")
            .where(({ or, eb }) =>
              or([
                eb("sp.status", "in", OPEN_PAYOUT_STATUSES),
                eb.and([
                  eb("sp.status", "=", "completed"),
                  eb("sp.created_at", ">", weekAgo),
                ]),
                // Toss took it and the bank turned it down: tried again a
                // week on, or as soon as the seller changes their account.
                eb.and([
                  eb("sp.status", "=", "failed"),
                  eb("sp.toss_payout_id", "is not", null),
                  eb("sp.finished_at", ">", weekAgo),
                  eb("sp.finished_at", ">", eb.ref("s.updated_at")),
                ]),
              ]),
            ),
        ),
      ),
    )
    .execute();

  let created = 0;
  for (const seller of sellers) {
    if (await createPayout(seller.id, heldUntil)) created++;
  }
  return created;
}

async function createPayout(
  sellerId: string,
  heldUntil: Date,
): Promise<string | null> {
  return db.transaction().execute(async (trx) => {
    // A refund request takes the same lock before it holds a purchase back.
    const purchases = await trx
      .selectFrom("template_purchases")
      .select(["id", "amount", "fee"])
      .where("seller_id", "=", sellerId)
      .where("status", "=", "done")
      .where("payout_id", "is", null)
      .where("refund_requested_at", "is", null)
      .where("paid_at", "<=", heldUntil)
      .forUpdate()
      .execute();
    const amount = purchases.reduce(
      (sum, purchase) => sum + purchase.amount - purchase.fee,
      0,
    );
    if (amount < MIN_PAYOUT_AMOUNT) return null;
    // seller_payouts_one_open_idx refuses a second open payout.
    const payout = await trx
      .insertInto("seller_payouts")
      .values({ seller_id: sellerId, amount })
      .returning("id")
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    if (!payout) return null;
    await trx
      .updateTable("template_purchases")
      .set({ payout_id: payout.id })
      .where(
        "id",
        "in",
        purchases.map((purchase) => purchase.id),
      )
      .execute();
    await enqueueJob(
      trx,
      { kind: "request_payout", payoutId: payout.id },
      { dedupeKey: `payout-request:${payout.id}` },
    );
    return payout.id;
  });
}

// Ends a payout that moved no money, freeing its purchases for the next one.
async function releasePayout(
  payoutId: string,
  status: Extract<PayoutStatus, "failed" | "canceled">,
  error: { code: string; message: string } | null,
) {
  await db.transaction().execute(async (trx) => {
    const ended = await trx
      .updateTable("seller_payouts")
      .set({
        status,
        error: error ? JSON.stringify(error) : null,
        finished_at: new Date(),
      })
      .where("id", "=", payoutId)
      .where("status", "in", OPEN_PAYOUT_STATUSES)
      .returning("id")
      .executeTakeFirst();
    if (!ended) return;
    await trx
      .updateTable("template_purchases")
      .set({ payout_id: null })
      .where("payout_id", "=", payoutId)
      .execute();
  });
}

/** The task's first step: asks Toss to pay a pending payout. */
export async function sendPayout(payoutId: string, now = new Date()) {
  const payout = await db
    .selectFrom("seller_payouts as sp")
    .innerJoin("market_sellers as s", "s.id", "sp.seller_id")
    .select([
      "sp.id",
      "sp.amount",
      "sp.status",
      "sp.payout_date",
      "s.toss_seller_id",
    ])
    .where("sp.id", "=", payoutId)
    .executeTakeFirstOrThrow();
  if (payout.status !== "pending") return;
  if (!payout.toss_seller_id) {
    await releasePayout(payoutId, "failed", {
      code: "NO_SELLER",
      message: "Toss에 등록되지 않은 판매자",
    });
    return;
  }
  // The date goes with the payout: a retry under the same idempotency key
  // must send the same body.
  let payoutDate = payout.payout_date;
  if (!payoutDate) {
    payoutDate = nextPayoutDate(now);
    await db
      .updateTable("seller_payouts")
      .set({ payout_date: payoutDate })
      .where("id", "=", payoutId)
      .execute();
  }

  let items: TossPayout[];
  try {
    items = await requestPayouts(
      [
        {
          refPayoutId: payout.id,
          destination: payout.toss_seller_id,
          scheduleType: "SCHEDULED",
          payoutDate,
          amount: { currency: "KRW", value: payout.amount },
          transactionDescription: PAYOUT_DESCRIPTION,
        },
      ],
      `payout-${payout.id}`,
    );
  } catch (error) {
    if (isDefinitiveTossFailure(error)) {
      await releasePayout(payoutId, "failed", {
        code: error.code ?? String(error.status),
        message: error.message,
      });
      return;
    }
    // Not known whether Toss took it: the task retries under the same key.
    throw error;
  }
  const item = items.find((entry) => entry.refPayoutId === payout.id);
  if (!item) throw new Error(`Toss answered payout ${payout.id} without it`);
  await applyTossPayout(payout.id, item);
}

const TOSS_PAYOUT_STATUSES: Record<string, PayoutStatus> = {
  REQUESTED: "requested",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
  REJECTED: "failed",
  CANCELED: "canceled",
  DELETED: "canceled",
};

async function applyTossPayout(payoutId: string, item: TossPayout) {
  const status = TOSS_PAYOUT_STATUSES[item.status];
  if (!status) throw new Error(`Unknown Toss payout status ${item.status}`);
  if (status === "failed" || status === "canceled") {
    await db
      .updateTable("seller_payouts")
      .set({ toss_payout_id: item.id })
      .where("id", "=", payoutId)
      .execute();
    await releasePayout(payoutId, status, item.error);
    return;
  }
  await db
    .updateTable("seller_payouts")
    .set({
      status,
      toss_payout_id: item.id,
      payout_date: item.payoutDate,
      requested_at: sql`coalesce(requested_at, ${new Date(item.requestedAt)})`,
      ...(status === "completed" ? { finished_at: new Date() } : {}),
    })
    .where("id", "=", payoutId)
    .where("status", "in", OPEN_PAYOUT_STATUSES)
    .execute();
}

/**
 * Takes back a payout Toss hasn't started on (SCHEDULED, still REQUESTED),
 * for a sale in it refunded since: its other sales go in the next one.
 * Returns whether it was.
 */
export async function cancelOpenPayout(payoutId: string): Promise<boolean> {
  const payout = await db
    .selectFrom("seller_payouts")
    .select(["status", "toss_payout_id"])
    .where("id", "=", payoutId)
    .executeTakeFirstOrThrow();
  if (payout.status !== "requested" || !payout.toss_payout_id) return false;
  let item: TossPayout;
  try {
    item = await cancelPayout(payout.toss_payout_id);
  } catch (error) {
    // Already under way, or done: past taking back.
    if (isDefinitiveTossFailure(error)) return false;
    throw error;
  }
  await applyTossPayout(payoutId, item);
  return TOSS_PAYOUT_STATUSES[item.status] === "canceled";
}

/** Brings a payout in line with Toss: from the webhook, and daily. */
export async function syncPayout(payoutId: string): Promise<void> {
  const payout = await db
    .selectFrom("seller_payouts")
    .select(["id", "status", "toss_payout_id"])
    .where("id", "=", payoutId)
    .executeTakeFirstOrThrow();
  if (!OPEN_PAYOUT_STATUSES.includes(payout.status)) return;
  if (!payout.toss_payout_id) {
    // A webhook ahead of sendPayout's answer: the task retries once Toss's
    // id is written, or finds the payout ended.
    throw new Error(`Payout ${payout.id} has no Toss id yet`);
  }
  let item: TossPayout;
  try {
    item = await getPayout(payout.toss_payout_id);
  } catch (error) {
    if (error instanceof TossApiError && error.status === 404) return;
    throw error;
  }
  await applyTossPayout(payout.id, item);
}

// Payouts still to be sent an hour after they were made: their task gave up
// on Toss. Sent again under the same idempotency key.
export async function unsentPayoutIds(now = new Date()): Promise<string[]> {
  const rows = await db
    .selectFrom("seller_payouts")
    .select("id")
    .where("status", "=", "pending")
    .where("created_at", "<", new Date(now.getTime() - 60 * 60 * 1000))
    .execute();
  return rows.map((row) => row.id);
}

// Open payouts Toss has already accepted, to look at again in case a
// webhook was missed.
export async function openPayoutIds(): Promise<string[]> {
  const rows = await db
    .selectFrom("seller_payouts")
    .select("id")
    .where("status", "in", ["requested", "in_progress"])
    .execute();
  return rows.map((row) => row.id);
}

export interface SellerEarnings {
  // Sold and kept, not yet in a payout.
  unpaid: number;
  // Of which past the hold, to go in the next payout.
  ready: number;
  paidOut: number;
  payouts: {
    id: string;
    amount: number;
    status: PayoutStatus;
    payoutDate: string | null;
    createdAt: Date;
    error: string | null;
  }[];
  sales: {
    id: string;
    title: string;
    amount: number;
    share: number;
    paidAt: Date | null;
    status: string;
  }[];
}

export async function sellerEarnings(
  user: User,
): Promise<SellerEarnings | null> {
  const seller = await db
    .selectFrom("market_sellers")
    .select("id")
    .where("user_id", "=", user.id)
    .executeTakeFirst();
  if (!seller) return null;
  const heldUntil = new Date(Date.now() - PAYOUT_HOLD_DAYS * DAY_MS);
  const sales = await db
    .selectFrom("template_purchases")
    .select([
      "id",
      "template_title",
      "amount",
      "fee",
      "paid_at",
      "status",
      "payout_id",
      "refund_requested_at",
    ])
    .where("seller_id", "=", seller.id)
    .where("status", "in", ["done", "canceled"])
    .orderBy("paid_at", "desc")
    .execute();
  const payouts = await db
    .selectFrom("seller_payouts")
    .selectAll()
    .where("seller_id", "=", seller.id)
    .orderBy("created_at", "desc")
    .limit(50)
    .execute();
  // Every completed payout, not only the 50 listed.
  const paid = await db
    .selectFrom("seller_payouts")
    .select(({ fn }) => fn.sum<string | null>("amount").as("total"))
    .where("seller_id", "=", seller.id)
    .where("status", "=", "completed")
    .executeTakeFirstOrThrow();
  const unpaidSales = sales.filter(
    (sale) =>
      sale.status === "done" && !sale.payout_id && !sale.refund_requested_at,
  );
  return {
    unpaid: unpaidSales.reduce((sum, sale) => sum + sale.amount - sale.fee, 0),
    ready: unpaidSales
      .filter((sale) => sale.paid_at && new Date(sale.paid_at) <= heldUntil)
      .reduce((sum, sale) => sum + sale.amount - sale.fee, 0),
    paidOut: Number(paid.total ?? 0),
    payouts: payouts.map((payout) => ({
      id: payout.id,
      amount: payout.amount,
      status: payout.status,
      payoutDate: payout.payout_date,
      createdAt: payout.created_at,
      error: payout.error?.message ?? null,
    })),
    sales: sales.slice(0, 100).map((sale) => ({
      id: sale.id,
      title: sale.template_title,
      amount: sale.amount,
      share: sale.amount - sale.fee,
      paidAt: sale.paid_at,
      status: sale.status,
    })),
  };
}
