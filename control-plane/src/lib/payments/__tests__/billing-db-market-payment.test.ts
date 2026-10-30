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
const { createDuePayouts, syncPayout } =
  require("@/lib/market/payouts") as typeof import("@/lib/market/payouts");

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

  test("a dashboard refund of a sale already paid out is reported, not undone", async () => {
    const author = await makeUser();
    const templateId = await makeTemplate(author);
    await makeSeller(author);
    await setTemplatePrice(author, templateId, 5000);
    const { order, purchaseId } = await buy(await makeUser(), templateId);
    await age(purchaseId, 11);
    toss.requestPayouts.mockImplementationOnce(async ([input]) => [
      {
        ...input,
        id: "FPA_2",
        payoutDate: input.payoutDate!,
        requestedAt: "2026-11-02T10:00:00+09:00",
        status: "REQUESTED",
        error: null,
      } as TossPayout,
    ]);
    await createDuePayouts();
    await runDueJobs();

    toss.getPaymentByOrderId.mockResolvedValueOnce({
      ...approved(order.orderId, 5000),
      status: "CANCELED",
    });
    await enqueueJob(db, { kind: "reconcile_template_purchase", purchaseId });
    await runDueJobs();
    const purchase = await db
      .selectFrom("template_purchases")
      .select(["status", "payout_id"])
      .executeTakeFirstOrThrow();
    expect(purchase.status).toBe("done");
    expect(purchase.payout_id).not.toBeNull();
    const events = await db
      .selectFrom("payment_events")
      .select("kind")
      .where("kind", "=", "template_refund_after_payout")
      .execute();
    expect(events).toHaveLength(1);
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
