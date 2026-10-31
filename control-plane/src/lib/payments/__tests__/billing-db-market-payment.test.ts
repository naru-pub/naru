/** @jest-environment node */
import { resetLedgerFixtures } from "@/test-support/ledger-fixtures";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import type { TossPaymentResult, TossPayout } from "@/lib/payments/toss";
import type { User } from "@/lib/auth";

jest.mock("@/lib/payments/toss", () => {
  const actual = jest.requireActual<typeof import("@/lib/payments/toss")>(
    "@/lib/payments/toss",
  );
  return {
    ...actual,
    cancelPayment: jest.fn(),
    confirmPayment: jest.fn(),
    getPaymentByOrderId: jest.fn(),
    registerSeller: jest.fn(),
    getSeller: jest.fn(),
    requestPayouts: jest.fn(),
    getPayout: jest.fn(),
    cancelPayout: jest.fn(),
    deleteSeller: jest.fn(),
  };
});
jest.mock("@/lib/auth", () => ({ validateRequest: jest.fn() }));

// Required after the mocks: this transform does not hoist jest.mock above
// imports.
const { sql } = require("kysely") as typeof import("kysely");
const { db, pool } =
  require("@/lib/database") as typeof import("@/lib/database");
const toss = require("@/lib/payments/toss") as jest.Mocked<
  typeof import("@/lib/payments/toss")
>;
const { enqueueJob, runDueJobs } =
  require("@/lib/payments/payment-jobs") as typeof import("@/lib/payments/payment-jobs");
const { registerAsSeller } =
  require("@/lib/market/sellers") as typeof import("@/lib/market/sellers");
const { setTemplatePrice } =
  require("@/lib/market/pricing") as typeof import("@/lib/market/pricing");
const {
  acceptTemplatePurchase,
  listPurchases,
  prepareTemplatePurchase,
  requestTemplateRefund,
} =
  require("@/lib/market/purchases") as typeof import("@/lib/market/purchases");
const { assertCanUseTemplate } =
  require("@/lib/market/access") as typeof import("@/lib/market/access");
const { createDuePayouts, sellerEarnings, syncPayout } =
  require("@/lib/market/payouts") as typeof import("@/lib/market/payouts");
const { handleMarketJob, runMarketMaintenance } =
  require("@/lib/market/market-jobs") as typeof import("@/lib/market/market-jobs");
const { checkMarketInvariants } =
  require("@/lib/market/invariants") as typeof import("@/lib/market/invariants");
const { deleteUserRow, settleChargesBeforeDeletion } =
  require("@/lib/account-deletion") as typeof import("@/lib/account-deletion");
const { deletePost } =
  require("@/lib/board/posts") as typeof import("@/lib/board/posts");

// The template marketplace against a disposable, migrated database
// (scripts/test-payments-db.sh), Toss mocked at lib/payments/toss.
jest.setTimeout(30_000);
const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;
let counter = 0;

async function makeUser(): Promise<User> {
  counter += 1;
  const row = await db
    .insertInto("users")
    .values({
      login_name: `market${counter}`,
      password_hash: "x",
      email: `market${counter}@example.com`,
      email_verified_at: new Date(),
    })
    .returning(["id", "login_name", "email", "email_verified_at", "created_at"])
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    loginName: row.login_name,
    email: row.email,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
  } as unknown as User;
}

async function makeTemplate(author: User) {
  const post = await db
    .insertInto("board_posts")
    .values({ user_id: author.id, kind: "template", title: "포트폴리오" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const template = await db
    .insertInto("board_templates")
    .values({
      post_id: post.id,
      user_id: author.id,
      slug: `t${counter}`,
      license: "mit",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const version = await db
    .insertInto("board_template_versions")
    .values({
      template_id: template.id,
      version: 1,
      source_path: "",
      file_count: 1,
      size_bytes: 10,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .updateTable("board_templates")
    .set({ latest_version_id: version.id })
    .where("id", "=", template.id)
    .execute();
  return template.id;
}

async function makeSeller(author: User, status = "PARTIALLY_APPROVED") {
  toss.registerSeller.mockImplementationOnce(async (input) => ({
    id: `seller-${input.refSellerId}`,
    refSellerId: input.refSellerId,
    businessType: input.businessType,
    status,
  }));
  return registerAsSeller(author, {
    businessType: "INDIVIDUAL",
    name: "김작가",
    email: "author@example.com",
    phone: "01012345678",
    bankCode: "092",
    accountNumber: "100012345678",
    holderName: "김작가",
  });
}

function approved(orderId: string, amount: number): TossPaymentResult {
  return {
    paymentKey: `pk-${orderId}`,
    orderId,
    status: "DONE",
    totalAmount: amount,
    approvedAt: new Date().toISOString(),
    method: "카드",
  };
}

// A bought template, approved by its task.
async function buy(buyer: User, templateId: string) {
  const order = await prepareTemplatePurchase(buyer, templateId);
  toss.confirmPayment.mockResolvedValueOnce(
    approved(order.orderId, order.amount),
  );
  const accepted = await acceptTemplatePurchase(buyer, {
    orderId: order.orderId,
    paymentKey: `pk-${order.orderId}`,
    amount: order.amount,
  });
  await runDueJobs();
  return { order, purchaseId: accepted.purchaseId };
}

// Toss's answer to a payout request: taken, for its date.
function takePayout(id: string) {
  toss.requestPayouts.mockImplementationOnce(async ([input]) => [
    {
      ...input,
      id,
      payoutDate: input.payoutDate!,
      requestedAt: "2026-11-02T10:00:00+09:00",
      status: "REQUESTED",
      error: null,
    } as TossPayout,
  ]);
}

const SELLER_INPUT = {
  businessType: "INDIVIDUAL",
  name: "김작가",
  email: "author@example.com",
  phone: "01012345678",
  bankCode: "092",
  accountNumber: "100012345678",
  holderName: "김작가",
};

async function age(purchaseId: string, days: number) {
  await db
    .updateTable("template_purchases")
    .set({ paid_at: new Date(Date.now() - days * DAY) })
    .where("id", "=", purchaseId)
    .execute();
}

integration("template marketplace", () => {
  beforeEach(async () => {
    await resetLedgerFixtures(
      db,
      sql`truncate absurd.c_payments, absurd.e_payments, absurd.r_payments, absurd.t_payments, absurd.w_payments, users, toss_calls, payment_events restart identity cascade`,
    );
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await db.destroy().catch(() => {});
    await pool.end().catch(() => {});
  });

  test("a price takes a registered seller", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await expect(setTemplatePrice(author, templateId, 5000)).rejects.toThrow(
      "판매자 정산 정보",
    );
    const seller = await makeSeller(author);
    expect(seller.accountLast4).toBe("5678");
    // Toss holds the account; 나루 keeps its last digits only.
    const row = await db
      .selectFrom("market_sellers")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain("100012345678");
    await expect(setTemplatePrice(author, templateId, 1050)).rejects.toThrow(
      "100원 단위",
    );
    expect(await setTemplatePrice(author, templateId, 5000)).toBe(5000);
    const stranger = await makeUser();
    await expect(setTemplatePrice(stranger, templateId, 0)).rejects.toThrow(
      "내 템플릿",
    );
  });

  test("buying grants the template; the amount is 나루's", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 10000);
    const buyer = await makeUser();

    await expect(assertCanUseTemplate(buyer.id, templateId)).rejects.toThrow(
      "유료 템플릿",
    );
    await expect(assertCanUseTemplate(author.id, templateId)).resolves.toBe(
      undefined,
    );

    const order = await prepareTemplatePurchase(buyer, templateId);
    expect(order.amount).toBe(10000);
    await expect(
      acceptTemplatePurchase(buyer, {
        orderId: order.orderId,
        paymentKey: "pk",
        amount: 100,
      }),
    ).rejects.toThrow("올바르지 않습니다");

    toss.confirmPayment.mockResolvedValueOnce(approved(order.orderId, 10000));
    await acceptTemplatePurchase(buyer, {
      orderId: order.orderId,
      paymentKey: `pk-${order.orderId}`,
      amount: 10000,
    });
    await runDueJobs();
    expect(toss.confirmPayment).toHaveBeenCalledWith(
      {
        paymentKey: `pk-${order.orderId}`,
        orderId: order.orderId,
        amount: 10000,
      },
      order.orderId,
      "market",
    );
    const purchase = await db
      .selectFrom("template_purchases")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(purchase).toMatchObject({
      status: "done",
      amount: 10000,
      fee: 2000,
    });
    await expect(assertCanUseTemplate(buyer.id, templateId)).resolves.toBe(
      undefined,
    );
    await expect(prepareTemplatePurchase(buyer, templateId)).rejects.toThrow(
      "이미 산",
    );
    // Raising the price later does not take it back.
    await setTemplatePrice(author, templateId, 20000);
    await expect(assertCanUseTemplate(buyer.id, templateId)).resolves.toBe(
      undefined,
    );
  });

  test("a second tab's order is let go, not charged", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 3000);
    const buyer = await makeUser();
    const second = await prepareTemplatePurchase(buyer, templateId);
    await buy(buyer, templateId);
    await acceptTemplatePurchase(buyer, {
      orderId: second.orderId,
      paymentKey: `pk-${second.orderId}`,
      amount: 3000,
    });
    toss.confirmPayment.mockClear();
    await runDueJobs();
    expect(toss.confirmPayment).not.toHaveBeenCalled();
    const statuses = await db
      .selectFrom("template_purchases")
      .select("status")
      .orderBy("created_at")
      .execute();
    expect(statuses.map((row) => row.status).sort()).toEqual([
      "done",
      "expired",
    ]);
  });

  test("sales past the hold are paid out once, and a refused payout frees them", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 10000);
    const early = await buy(await makeUser(), templateId);
    const late = await buy(await makeUser(), templateId);
    await age(early.purchaseId, 11);
    await age(late.purchaseId, 2);

    // A holiday: Toss refuses the date.
    toss.requestPayouts.mockRejectedValueOnce(
      new toss.TossApiError("휴일입니다", 400, "INVALID_PAYOUT_DATE"),
    );
    expect(await createDuePayouts()).toBe(1);
    await runDueJobs();
    let payouts = await db.selectFrom("seller_payouts").selectAll().execute();
    expect(payouts).toEqual([
      expect.objectContaining({ status: "failed", amount: 8000 }),
    ]);
    expect(
      (
        await db
          .selectFrom("template_purchases")
          .select("payout_id")
          .where("id", "=", early.purchaseId)
          .executeTakeFirstOrThrow()
      ).payout_id,
    ).toBeNull();

    toss.requestPayouts.mockImplementationOnce(async ([input]) => [
      {
        ...input,
        id: "FPA_1",
        payoutDate: input.payoutDate!,
        requestedAt: "2026-11-02T10:00:00+09:00",
        status: "REQUESTED",
        error: null,
      } as TossPayout,
    ]);
    expect(await createDuePayouts()).toBe(1);
    await runDueJobs();
    expect(toss.requestPayouts).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          destination: expect.stringMatching(/^seller-naru/),
          scheduleType: "SCHEDULED",
          amount: { currency: "KRW", value: 8000 },
        }),
      ],
      expect.stringMatching(/^payout-/),
    );
    // One open payout at a time.
    expect(await createDuePayouts()).toBe(0);

    payouts = await db
      .selectFrom("seller_payouts")
      .selectAll()
      .where("status", "=", "requested")
      .execute();
    expect(payouts).toHaveLength(1);
    toss.getPayout.mockResolvedValueOnce({
      id: "FPA_1",
      status: "COMPLETED",
      payoutDate: payouts[0].payout_date!,
      requestedAt: "2026-11-02T10:00:00+09:00",
    } as TossPayout);
    await syncPayout(payouts[0].id);
    const done = await db
      .selectFrom("seller_payouts")
      .selectAll()
      .where("id", "=", payouts[0].id)
      .executeTakeFirstOrThrow();
    expect(done.status).toBe("completed");
    // The later sale waits for its hold and the next week.
    await age(late.purchaseId, 11);
    expect(await createDuePayouts()).toBe(0);
  });

  test("a seller Toss does not pay out to yet is skipped", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author, "APPROVAL_REQUIRED");
    await setTemplatePrice(author, templateId, 5000);
    const sale = await buy(await makeUser(), templateId);
    await age(sale.purchaseId, 20);
    expect(await createDuePayouts()).toBe(0);
  });

  test("a refund is held out of payouts and cancels the payment", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const { order, purchaseId } = await buy(buyer, templateId);
    const [listed] = await listPurchases(buyer);
    expect(listed.refundable).toBe(true);

    toss.cancelPayment.mockResolvedValueOnce({
      ...approved(order.orderId, 5000),
      status: "CANCELED",
    });
    await requestTemplateRefund(buyer, purchaseId);
    await runDueJobs();
    expect(toss.cancelPayment).toHaveBeenCalledWith(
      expect.objectContaining({ flow: "market" }),
    );
    const purchase = await db
      .selectFrom("template_purchases")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(purchase.status).toBe("canceled");
    await expect(assertCanUseTemplate(buyer.id, templateId)).rejects.toThrow();
    await age(purchaseId, 20);
    expect(await createDuePayouts()).toBe(0);
  });

  test("a dashboard refund of a sale in a payout Toss hasn't started takes the payout back", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const refunded = await buy(buyer, templateId);
    const kept = await buy(await makeUser(), templateId);
    await age(refunded.purchaseId, 11);
    await age(kept.purchaseId, 11);
    takePayout("FPA_2");
    await createDuePayouts();
    await runDueJobs();

    toss.getPaymentByOrderId.mockResolvedValueOnce({
      ...approved(refunded.order.orderId, 5000),
      status: "CANCELED",
    });
    toss.cancelPayout.mockResolvedValueOnce({
      id: "FPA_2",
      status: "CANCELED",
      error: null,
    } as TossPayout);
    await enqueueJob(db, {
      kind: "reconcile_template_purchase",
      purchaseId: refunded.purchaseId,
    });
    await runDueJobs();

    expect(toss.cancelPayout).toHaveBeenCalledWith("FPA_2");
    const payout = await db
      .selectFrom("seller_payouts")
      .select("status")
      .executeTakeFirstOrThrow();
    expect(payout.status).toBe("canceled");
    const purchases = await db
      .selectFrom("template_purchases")
      .select(["id", "status", "payout_id"])
      .execute();
    expect(purchases).toEqual(
      expect.arrayContaining([
        { id: refunded.purchaseId, status: "canceled", payout_id: null },
        { id: kept.purchaseId, status: "done", payout_id: null },
      ]),
    );
    await expect(assertCanUseTemplate(buyer.id, templateId)).rejects.toThrow();
    expect(
      await db.selectFrom("payment_events").select("kind").execute(),
    ).not.toContainEqual({ kind: "template_refund_after_payout" });
    // The kept sale goes in the next payout, without the refunded one.
    takePayout("FPA_3");
    expect(await createDuePayouts()).toBe(1);
    await runDueJobs();
    expect(toss.requestPayouts).toHaveBeenLastCalledWith(
      [expect.objectContaining({ amount: { currency: "KRW", value: 4000 } })],
      expect.any(String),
    );
  });

  test("a dashboard refund of a sale already paid out is reported and revokes it", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const { order, purchaseId } = await buy(buyer, templateId);
    await age(purchaseId, 11);
    takePayout("FPA_4");
    await createDuePayouts();
    await runDueJobs();
    await db
      .updateTable("seller_payouts")
      .set({ status: "completed", finished_at: new Date() })
      .execute();

    toss.getPaymentByOrderId.mockResolvedValueOnce({
      ...approved(order.orderId, 5000),
      status: "CANCELED",
    });
    await enqueueJob(db, { kind: "reconcile_template_purchase", purchaseId });
    await runDueJobs();
    expect(toss.cancelPayout).not.toHaveBeenCalled();
    const purchase = await db
      .selectFrom("template_purchases")
      .select(["status", "payout_id"])
      .executeTakeFirstOrThrow();
    expect(purchase.status).toBe("canceled");
    expect(purchase.payout_id).not.toBeNull();
    await expect(assertCanUseTemplate(buyer.id, templateId)).rejects.toThrow();
    const events = await db
      .selectFrom("payment_events")
      .select("kind")
      .where("kind", "=", "template_refund_after_payout")
      .execute();
    expect(events).toHaveLength(1);
    expect((await sellerEarnings(author))?.paidOut).toBe(4000);
  });

  test("a refused registration goes again under a new refSellerId", async () => {
    const author = await makeUser();
    toss.registerSeller.mockRejectedValueOnce(
      new toss.TossApiError("계좌를 확인해 주세요", 400, "INVALID_ACCOUNT"),
    );
    await expect(registerAsSeller(author, SELLER_INPUT)).rejects.toThrow(
      "정산 정보를 받지 않았어요",
    );
    const first = toss.registerSeller.mock.calls[0][0].refSellerId;
    await makeSeller(author);
    const second = toss.registerSeller.mock.calls[1][0].refSellerId;
    expect(second).not.toBe(first);
  });

  test("a registration whose answer was lost keeps its refSellerId", async () => {
    const author = await makeUser();
    toss.registerSeller.mockRejectedValueOnce(
      new toss.TossApiError("timeout", 504),
    );
    await expect(registerAsSeller(author, SELLER_INPUT)).rejects.toThrow();
    await makeSeller(author);
    const [[first], [second]] = toss.registerSeller.mock.calls;
    expect(second.refSellerId).toBe(first.refSellerId);
  });

  test("a template can't be applied, or bought again, while its refund goes through", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const { purchaseId } = await buy(buyer, templateId);
    toss.cancelPayment.mockRejectedValueOnce(
      new toss.TossApiError("timeout", 504),
    );
    toss.getPaymentByOrderId.mockRejectedValueOnce(
      new toss.TossApiError("timeout", 504),
    );
    await requestTemplateRefund(buyer, purchaseId);
    await runDueJobs();
    await expect(assertCanUseTemplate(buyer.id, templateId)).rejects.toThrow(
      "유료 템플릿",
    );
    await expect(prepareTemplatePurchase(buyer, templateId)).rejects.toThrow(
      "환불을 처리하고 있어요",
    );
  });

  test("an application made under a refunded purchase doesn't keep the template", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    const version = await db
      .selectFrom("board_template_versions")
      .select("id")
      .executeTakeFirstOrThrow();
    // Applied while it was free: kept.
    const early = await makeUser();
    await db
      .insertInto("board_template_applications")
      .values({ user_id: early.id, version_id: version.id })
      .execute();
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const { order, purchaseId } = await buy(buyer, templateId);
    await db
      .insertInto("board_template_applications")
      .values({ user_id: buyer.id, version_id: version.id })
      .execute();
    toss.getPaymentByOrderId.mockResolvedValueOnce({
      ...approved(order.orderId, 5000),
      status: "CANCELED",
    });
    await enqueueJob(db, { kind: "reconcile_template_purchase", purchaseId });
    await runDueJobs();

    await expect(assertCanUseTemplate(buyer.id, templateId)).rejects.toThrow(
      "유료 템플릿",
    );
    await expect(assertCanUseTemplate(early.id, templateId)).resolves.toBe(
      undefined,
    );
  });

  test("a payout whose task gave up is sent again by the daily run", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const sale = await buy(await makeUser(), templateId);
    await age(sale.purchaseId, 11);
    expect(await createDuePayouts()).toBe(1);
    // As if every attempt had failed: the row is pending, its task gone.
    await sql`truncate absurd.c_payments, absurd.e_payments, absurd.r_payments, absurd.t_payments, absurd.w_payments`.execute(
      db,
    );
    await db
      .updateTable("seller_payouts")
      .set({ created_at: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .execute();

    takePayout("FPA_5");
    await runMarketMaintenance();
    await runDueJobs();
    const [payout] = await db
      .selectFrom("seller_payouts")
      .selectAll()
      .execute();
    expect(payout).toMatchObject({
      status: "requested",
      toss_payout_id: "FPA_5",
    });
    expect(toss.requestPayouts).toHaveBeenCalledWith(
      expect.any(Array),
      `payout-${payout.id}`,
    );
  });

  test("a payout the bank turned down waits a week, or for a new account", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const sale = await buy(await makeUser(), templateId);
    await age(sale.purchaseId, 11);
    takePayout("FPA_6");
    await createDuePayouts();
    await runDueJobs();
    const [payout] = await db
      .selectFrom("seller_payouts")
      .selectAll()
      .execute();
    toss.getPayout.mockResolvedValueOnce({
      id: "FPA_6",
      status: "FAILED",
      error: { code: "INVALID_ACCOUNT", message: "계좌 오류" },
    } as TossPayout);
    await syncPayout(payout.id);
    expect(
      (
        await db
          .selectFrom("template_purchases")
          .select("payout_id")
          .executeTakeFirstOrThrow()
      ).payout_id,
    ).toBeNull();

    expect(await createDuePayouts()).toBe(0);
    expect(await createDuePayouts(new Date(Date.now() + 8 * DAY))).toBe(1);
  });

  test("a payout the bank turned down goes again once the account changes", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const sale = await buy(await makeUser(), templateId);
    await age(sale.purchaseId, 11);
    takePayout("FPA_7");
    await createDuePayouts();
    await runDueJobs();
    const [payout] = await db
      .selectFrom("seller_payouts")
      .selectAll()
      .execute();
    toss.getPayout.mockResolvedValueOnce({
      id: "FPA_7",
      status: "FAILED",
      error: { code: "INVALID_ACCOUNT", message: "계좌 오류" },
    } as TossPayout);
    await syncPayout(payout.id);
    expect(await createDuePayouts()).toBe(0);

    await db
      .updateTable("market_sellers")
      .set({ updated_at: new Date(Date.now() + 1000) })
      .execute();
    expect(await createDuePayouts(new Date(Date.now() + 2000))).toBe(1);
  });

  test("an author with sales can still delete their account; the purchases stay", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const { purchaseId } = await buy(buyer, templateId);

    await db.transaction().execute((trx) => deleteUserRow(trx, author.id));

    const purchase = await db
      .selectFrom("template_purchases")
      .select(["template_id", "template_title", "status", "seller_id"])
      .where("id", "=", purchaseId)
      .executeTakeFirstOrThrow();
    expect(purchase).toMatchObject({
      template_id: null,
      template_title: "포트폴리오",
      status: "done",
    });
    const [listed] = await listPurchases(buyer);
    expect(listed).toMatchObject({ id: purchaseId, templateId: null });
  });

  test("an order whose template went with its author is let go, not charged", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const order = await prepareTemplatePurchase(buyer, templateId);
    await db.transaction().execute((trx) => deleteUserRow(trx, author.id));
    await acceptTemplatePurchase(buyer, {
      orderId: order.orderId,
      paymentKey: `pk-${order.orderId}`,
      amount: order.amount,
    });
    await runDueJobs();
    expect(toss.confirmPayment).not.toHaveBeenCalled();
    const purchase = await db
      .selectFrom("template_purchases")
      .select("status")
      .executeTakeFirstOrThrow();
    expect(purchase.status).toBe("expired");
  });

  test("a second order approved alongside the first is refunded", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const second = await prepareTemplatePurchase(buyer, templateId);
    await buy(buyer, templateId);
    // As if its approval had gone through at the same moment: charged,
    // with the answer not yet written.
    await db
      .updateTable("template_purchases")
      .set({
        toss_payment_key: `pk-${second.orderId}`,
        charge_attempted_at: new Date(),
      })
      .where("order_id", "=", second.orderId)
      .execute();
    toss.getPaymentByOrderId.mockResolvedValueOnce(
      approved(second.orderId, 5000),
    );
    toss.cancelPayment.mockResolvedValueOnce({
      ...approved(second.orderId, 5000),
      status: "CANCELED",
    });
    const { id } = await db
      .selectFrom("template_purchases")
      .select("id")
      .where("order_id", "=", second.orderId)
      .executeTakeFirstOrThrow();
    await enqueueJob(db, { kind: "confirm_template_purchase", purchaseId: id });
    await runDueJobs();

    expect(toss.cancelPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "market",
        paymentKey: `pk-${second.orderId}`,
      }),
    );
    const statuses = await db
      .selectFrom("template_purchases")
      .select(["order_id", "status"])
      .execute();
    expect(statuses).toContainEqual({
      order_id: second.orderId,
      status: "canceled",
    });
    expect(statuses.filter((row) => row.status === "done")).toHaveLength(1);
  });

  test("an author can't delete a sold template's post", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    const { post_id: postId } = await db
      .selectFrom("board_templates")
      .select("post_id")
      .where("id", "=", templateId)
      .executeTakeFirstOrThrow();
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const { order } = await buy(await makeUser(), templateId);
    await expect(deletePost(author, postId)).rejects.toThrow(
      "산 사람이 있는 템플릿",
    );

    // Once the only sale is refunded, it can go.
    const { id: purchaseId } = await db
      .selectFrom("template_purchases")
      .select("id")
      .executeTakeFirstOrThrow();
    toss.getPaymentByOrderId.mockResolvedValueOnce({
      ...approved(order.orderId, 5000),
      status: "CANCELED",
    });
    await enqueueJob(db, { kind: "reconcile_template_purchase", purchaseId });
    await runDueJobs();
    await expect(deletePost(author, postId)).resolves.toMatchObject({
      templateId,
    });
  });

  test("a refund before its payout is sent takes the payout back without Toss", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const { order, purchaseId } = await buy(await makeUser(), templateId);
    await age(purchaseId, 11);
    expect(await createDuePayouts()).toBe(1);

    toss.getPaymentByOrderId.mockResolvedValueOnce({
      ...approved(order.orderId, 5000),
      status: "CANCELED",
    });
    // Ahead of the payout's own task, still queued.
    await handleMarketJob({ kind: "reconcile_template_purchase", purchaseId });
    await runDueJobs();

    expect(toss.requestPayouts).not.toHaveBeenCalled();
    expect(toss.cancelPayout).not.toHaveBeenCalled();
    const payout = await db
      .selectFrom("seller_payouts")
      .select("status")
      .executeTakeFirstOrThrow();
    expect(payout.status).toBe("canceled");
    expect(
      await db.selectFrom("payment_events").select("kind").execute(),
    ).not.toContainEqual({ kind: "template_refund_after_payout" });
  });

  test("a payout Toss rejects in its answer is tried again the next day", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const sale = await buy(await makeUser(), templateId);
    await age(sale.purchaseId, 11);
    toss.requestPayouts.mockImplementationOnce(async ([input]) => [
      {
        ...input,
        id: "FPA_8",
        payoutDate: input.payoutDate!,
        requestedAt: "2026-11-02T10:00:00+09:00",
        status: "REJECTED",
        error: { code: "INVALID_PAYOUT_DATE", message: "휴일입니다" },
      } as TossPayout,
    ]);
    await createDuePayouts();
    await runDueJobs();
    const [payout] = await db
      .selectFrom("seller_payouts")
      .selectAll()
      .execute();
    expect(payout).toMatchObject({ status: "failed", toss_payout_id: "FPA_8" });
    expect(await createDuePayouts()).toBe(1);
  });

  test("a charge for a template gone with its author mid-approval is refunded", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const order = await prepareTemplatePurchase(buyer, templateId);
    await db
      .updateTable("template_purchases")
      .set({
        toss_payment_key: `pk-${order.orderId}`,
        charge_attempted_at: new Date(),
      })
      .execute();
    await db.transaction().execute((trx) => deleteUserRow(trx, author.id));
    toss.getPaymentByOrderId.mockResolvedValueOnce(
      approved(order.orderId, 5000),
    );
    toss.cancelPayment.mockResolvedValueOnce({
      ...approved(order.orderId, 5000),
      status: "CANCELED",
    });
    const { id } = await db
      .selectFrom("template_purchases")
      .select("id")
      .executeTakeFirstOrThrow();
    await enqueueJob(db, { kind: "confirm_template_purchase", purchaseId: id });
    await runDueJobs();
    expect(toss.cancelPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentKey: `pk-${order.orderId}` }),
    );
    const purchase = await db
      .selectFrom("template_purchases")
      .select(["status", "template_id"])
      .executeTakeFirstOrThrow();
    expect(purchase).toEqual({ status: "canceled", template_id: null });
  });

  test("a buyer's account deletion lets their orders go, and waits on one Toss may have charged", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const open = await prepareTemplatePurchase(buyer, templateId);
    await acceptTemplatePurchase(buyer, {
      orderId: open.orderId,
      paymentKey: `pk-${open.orderId}`,
      amount: 5000,
    });
    const charging = await prepareTemplatePurchase(buyer, templateId);
    await db
      .updateTable("template_purchases")
      .set({
        toss_payment_key: `pk-${charging.orderId}`,
        charge_attempted_at: new Date(),
      })
      .where("order_id", "=", charging.orderId)
      .execute();

    // Toss is still approving the second.
    toss.getPaymentByOrderId.mockResolvedValueOnce({
      ...approved(charging.orderId, 5000),
      status: "IN_PROGRESS",
    });
    expect(await settleChargesBeforeDeletion(buyer.id)).toBe(false);
    // Then it fails.
    toss.getPaymentByOrderId.mockResolvedValueOnce({
      ...approved(charging.orderId, 5000),
      status: "ABORTED",
    });
    expect(await settleChargesBeforeDeletion(buyer.id)).toBe(true);
    await db.transaction().execute((trx) => deleteUserRow(trx, buyer.id));

    // The first order's queued approval finds it let go: nothing charged.
    await runDueJobs();
    expect(toss.confirmPayment).not.toHaveBeenCalled();
    const statuses = await db
      .selectFrom("template_purchases")
      .select(["order_id", "status"])
      .execute();
    expect(statuses).toEqual(
      expect.arrayContaining([
        { order_id: open.orderId, status: "expired" },
        { order_id: charging.orderId, status: "expired" },
      ]),
    );
  });

  test("a seller's account deletion wipes their details and removes them at Toss once paid", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const sale = await buy(await makeUser(), templateId);
    await age(sale.purchaseId, 11);
    takePayout("FPA_9");
    await createDuePayouts();
    await runDueJobs();

    await db.transaction().execute((trx) => deleteUserRow(trx, author.id));
    await runDueJobs();
    const seller = await db
      .selectFrom("market_sellers")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(seller).toMatchObject({
      display_name: "탈퇴한 판매자",
      holder_name: "",
      account_last4: "",
    });
    expect(seller.deleted_at).not.toBeNull();
    // The payout under way finishes first.
    expect(toss.deleteSeller).not.toHaveBeenCalled();

    await db
      .updateTable("seller_payouts")
      .set({ status: "completed", finished_at: new Date() })
      .execute();
    await handleMarketJob({ kind: "deregister_seller", sellerId: seller.id });
    expect(toss.deleteSeller).toHaveBeenCalledWith(seller.toss_seller_id!);
    expect(await checkMarketInvariants(new Date(Date.now() + 3 * DAY))).toEqual(
      {},
    );
    // And no new payouts, even for a sale left unpaid.
    await db
      .updateTable("template_purchases")
      .set({ payout_id: null })
      .execute();
    expect(await createDuePayouts(new Date(Date.now() + 8 * DAY))).toBe(0);
  });

  test("the nightly check finds nothing after an ordinary sale and payout", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const sale = await buy(await makeUser(), templateId);
    await buy(await makeUser(), templateId);
    await age(sale.purchaseId, 11);
    takePayout("FPA_10");
    await createDuePayouts();
    await runDueJobs();
    expect(await checkMarketInvariants()).toEqual({});
    // Toss never told of it, and the daily sync never caught it.
    const [payout] = await db
      .selectFrom("seller_payouts")
      .selectAll()
      .execute();
    const threeDaysOn = new Date(
      new Date(`${payout.payout_date}T12:00:00+09:00`).getTime() + 3 * DAY,
    );
    expect(await checkMarketInvariants(threeDaysOn)).toEqual({
      "지급일이 이틀 지나도 끝나지 않은 정산": [payout.id],
    });
  });

  test("the nightly check names each broken marketplace rule", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const paid = await buy(buyer, templateId);
    await age(paid.purchaseId, 11);
    takePayout("FPA_11");
    await createDuePayouts();
    await runDueJobs();
    const [payout] = await db
      .selectFrom("seller_payouts")
      .selectAll()
      .execute();
    // A payout that drifted from its sales, long past its date.
    await db
      .updateTable("seller_payouts")
      .set({ amount: 9999, payout_date: "2026-01-05" })
      .execute();
    // A sale claimed before its hold was up.
    const early = await buy(await makeUser(), templateId);
    await db
      .updateTable("template_purchases")
      .set({ payout_id: payout.id })
      .where("id", "=", early.purchaseId)
      .execute();
    // An order left unresolved for days.
    const stuck = await prepareTemplatePurchase(await makeUser(), templateId);
    await db
      .updateTable("template_purchases")
      .set({ created_at: new Date(Date.now() - 3 * DAY) })
      .where("order_id", "=", stuck.orderId)
      .execute();
    // A payout never sent, from another seller.
    const other = await makeUser();
    const otherTemplate = await makeTemplate(other);
    await makeSeller(other);
    await setTemplatePrice(other, otherTemplate, 5000);
    const otherSale = await buy(await makeUser(), otherTemplate);
    await age(otherSale.purchaseId, 14);
    await createDuePayouts();
    await db
      .updateTable("seller_payouts")
      .set({ created_at: new Date(Date.now() - 3 * DAY) })
      .where("status", "=", "pending")
      .execute();
    // An account deleted around the code that retires its seller.
    await db
      .updateTable("users")
      .set({ deleted_at: new Date() })
      .where("id", "=", other.id)
      .execute();
    // A retired seller still at Toss days later.
    await db
      .updateTable("market_sellers")
      .set({ deleted_at: new Date(Date.now() - 3 * DAY) })
      .where("user_id", "=", author.id)
      .execute();
    await db
      .updateTable("seller_payouts")
      .set({ status: "completed", finished_at: new Date() })
      .where("id", "=", payout.id)
      .execute();

    const found = await checkMarketInvariants();
    expect(found).toEqual({
      "이틀 넘게 결과를 모르는 템플릿 구매": [expect.any(String)],
      "정산 금액이 판매 몫의 합과 다름": [payout.id],
      "보류 기간 전에 정산에 들어간 판매": [early.purchaseId],
      "이틀 넘게 보내지 못한 정산": [expect.any(String)],
      "탈퇴한 계정의 판매자 정보가 남음": [expect.any(String)],
      "탈퇴하고 이틀 넘게 Toss에 남은 판매자": [expect.any(String)],
    });
  });

  test("a template applied after buying is not refunded", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const buyer = await makeUser();
    const { purchaseId } = await buy(buyer, templateId);
    const version = await db
      .selectFrom("board_template_versions")
      .select("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("board_template_applications")
      .values({ user_id: buyer.id, version_id: version.id })
      .execute();
    await expect(requestTemplateRefund(buyer, purchaseId)).rejects.toThrow(
      "적용하기 전에만",
    );
  });
});
