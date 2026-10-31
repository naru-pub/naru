import { sql } from "kysely";
import { db } from "@/lib/database";
import { PAYOUT_HOLD_DAYS } from "./constants";
import { OPEN_PAYOUT_STATUSES } from "./states";

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
// The daily market run reconciles pending orders and resends payouts, so a
// day can pass before either is looked at: two before it is a fault.
const STALE_MS = 2 * DAY_MS;

// The marketplace's rules (lib/market), checked nightly with the rest of the
// payment data (lib/payments/payment-invariants). One per kind of fault the
// marketplace's reviews turned up: a charge whose outcome nobody resolves, a
// payout that drifts from its sales or is never finished, a deleted account
// whose seller details or Toss registration outlive it. Returns, by rule,
// the ids that break it.
export async function checkMarketInvariants(
  now = new Date(),
): Promise<Record<string, string[]>> {
  const stale = new Date(now.getTime() - STALE_MS);
  const rules: Record<string, () => Promise<string[]>> = {
    // Every charge is recorded or refunded.
    "이틀 넘게 결과를 모르는 템플릿 구매": () =>
      ids(
        db
          .selectFrom("template_purchases")
          .select("id")
          .where("status", "=", "pending")
          .where(
            sql<Date>`coalesce(charge_attempted_at, created_at)`,
            "<",
            stale,
          ),
      ),
    // A payout pays exactly the shares of the sales it claims: those since
    // refunded included, which were in it when it was sent. One that ended
    // without moving money has let its sales go.
    "정산 금액이 판매 몫의 합과 다름": () =>
      ids(
        db
          .selectFrom("seller_payouts as sp")
          .select("sp.id")
          .where("sp.status", "in", [...OPEN_PAYOUT_STATUSES, "completed"])
          .where(
            "sp.amount",
            "!=",
            sql<number>`(select coalesce(sum(tp.amount - tp.fee), 0)::int
            from template_purchases tp where tp.payout_id = sp.id)`,
          ),
      ),
    "보류 기간 전에 정산에 들어간 판매": () =>
      ids(
        db
          .selectFrom("template_purchases as tp")
          .innerJoin("seller_payouts as sp", "sp.id", "tp.payout_id")
          .select("tp.id")
          .where(
            "tp.paid_at",
            ">",
            sql<Date>`sp.created_at - make_interval(days => ${PAYOUT_HOLD_DAYS})`,
          ),
      ),
    "이틀 넘게 보내지 못한 정산": () =>
      ids(
        db
          .selectFrom("seller_payouts")
          .select("id")
          .where("status", "=", "pending")
          .where("created_at", "<", stale),
      ),
    // Toss pays on the payout date; the daily sync records it the day after.
    "지급일이 이틀 지나도 끝나지 않은 정산": () =>
      ids(
        db
          .selectFrom("seller_payouts")
          .select("id")
          .where("status", "in", ["requested", "in_progress"])
          .where("payout_date", "<", kstDate(stale)),
      ),
    // Account deletion wipes what 나루 keeps of a seller (retireSeller), and
    // deregister_seller removes them at Toss once their payouts are done.
    "탈퇴한 계정의 판매자 정보가 남음": () =>
      ids(
        db
          .selectFrom("market_sellers as s")
          .innerJoin("users as u", "u.id", "s.user_id")
          .select("s.id")
          .where("u.deleted_at", "is not", null)
          .where((eb) =>
            eb.or([
              eb("s.deleted_at", "is", null),
              eb("s.holder_name", "!=", ""),
              eb("s.account_last4", "!=", ""),
            ]),
          ),
      ),
    "탈퇴하고 이틀 넘게 Toss에 남은 판매자": () =>
      ids(
        db
          .selectFrom("market_sellers as s")
          .select("s.id")
          .where("s.deleted_at", "<", stale)
          .where("s.toss_seller_id", "is not", null)
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom("seller_payouts as sp")
                  .select("sp.id")
                  .whereRef("sp.seller_id", "=", "s.id")
                  .where("sp.status", "in", OPEN_PAYOUT_STATUSES),
              ),
            ),
          ),
      ),
  };
  const found: Record<string, string[]> = {};
  for (const [rule, query] of Object.entries(rules)) {
    const list = await query();
    if (list.length > 0) found[rule] = list;
  }
  return found;
}

function kstDate(at: Date): string {
  return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

async function ids(query: {
  execute(): Promise<Array<{ id: string }>>;
}): Promise<string[]> {
  return (await query.execute()).map((row) => row.id);
}
