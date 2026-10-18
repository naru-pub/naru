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
import { sql } from "kysely";
import type { StoreState } from "@/lib/payments/store/ledger";

jest.mock("@/lib/email", () => ({
  setPaymentMailRecorder: jest.fn(),
}));
jest.mock("@/lib/operator-alerts", () => ({
  operatorAlertsConfigured: () => false,
  sendOperatorAlert: jest.fn(async () => {}),
}));

const { db } = require("@/lib/database") as typeof import("@/lib/database");
const { closeAccountLockPool } =
  require("@/lib/payments/account-lock") as typeof import("@/lib/payments/account-lock");
const {
  applyStoreState,
  moveStoreSubscription,
  revokeStoreTransaction,
  StoreOwnershipError,
  StoreTransferError,
} =
  require("@/lib/payments/store/ledger") as typeof import("@/lib/payments/store/ledger");
const { supporterStatus } =
  require("@/lib/payments/store/sync") as typeof import("@/lib/payments/store/sync");
const { prepareSubscription } =
  require("@/lib/payments/subscription-signup") as typeof import("@/lib/payments/subscription-signup");
const { checkPaymentInvariants } =
  require("@/lib/payments/payment-invariants") as typeof import("@/lib/payments/payment-invariants");
const { recomputePaidTime } =
  require("@/lib/payments/paid-time") as typeof import("@/lib/payments/paid-time");
const { entitlementRepairCandidates } =
  require("@/lib/payments/entitlement-repair") as typeof import("@/lib/payments/entitlement-repair");

// The App Store and Play ledger (lib/payments/store) against a disposable,
// migrated database (scripts/test-payments-db.sh).
const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;
let counter = 0;

async function loginOf(userId: string): Promise<string> {
  const row = await db
    .selectFrom("users")
    .select("login_name")
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  return row.login_name;
}

async function makeUser(): Promise<string> {
  counter++;
  const row = await db
    .insertInto("users")
    .values({
      login_name: `storebuyer${counter}`,
      password_hash: "x",
      email: `storebuyer${counter}@example.com`,
      email_verified_at: new Date(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function paidUntil(userId: string): Promise<Date | null> {
  const row = await db
    .selectFrom("users")
    .select("supporter_until")
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  return row.supporter_until;
}

function appleState(
  userId: string | null,
  opts: {
    key?: string;
    transactions: Array<{ id: string; end: Date; revokedAt?: Date }>;
    autoRenews?: boolean;
    store?: "apple" | "google";
  },
): StoreState {
  const last = opts.transactions[opts.transactions.length - 1];
  return {
    store: opts.store ?? "apple",
    storeKey: opts.key ?? "orig-1",
    productId:
      opts.store === "google" ? "supporter" : "pub.naru.supporter.monthly",
    environment: "sandbox",
    accountToken: userId,
    status: last.revokedAt ? "revoked" : "active",
    expiresAt: last.end,
    autoRenews: opts.autoRenews ?? true,
    transactions: opts.transactions.map((tx) => ({
      id: tx.id,
      purchasedAt: new Date(tx.end.getTime() - 30 * DAY),
      periodEnd: tx.end,
      revokedAt: tx.revokedAt ?? null,
    })),
  };
}

integration("store subscriptions", () => {
  beforeEach(async () => {
    await resetLedgerFixtures(
      db,
      sql`truncate absurd.c_payments, absurd.e_payments, absurd.r_payments, absurd.t_payments, absurd.w_payments, users, subscriptions, payments, card_registrations, payment_events, store_subscriptions, store_transactions, store_notifications restart identity cascade`,
    );
  });

  afterAll(async () => {
    await closeAccountLockPool();
    await db.destroy();
  });

  test("a purchase and its renewals grant paid time", async () => {
    const userId = await makeUser();
    const first = new Date(Date.now() + 30 * DAY);
    const second = new Date(Date.now() + 60 * DAY);
    const applied = await applyStoreState(
      appleState(userId, { transactions: [{ id: "t1", end: first }] }),
      { claimedBy: userId },
    );
    expect(applied.applied).toBe(true);
    expect(await paidUntil(userId)).toEqual(first);

    // The same report again changes nothing; a renewal extends.
    await applyStoreState(
      appleState(userId, { transactions: [{ id: "t1", end: first }] }),
    );
    await applyStoreState(
      appleState(userId, { transactions: [{ id: "t2", end: second }] }),
    );
    expect(await paidUntil(userId)).toEqual(second);
    const events = await db
      .selectFrom("payment_events")
      .select("kind")
      .where("user_id", "=", userId)
      .execute();
    expect(events.map((event) => event.kind)).toEqual([
      "store_charged",
      "store_charged",
    ]);
    expect(await checkPaymentInvariants()).toEqual({});
    expect(await entitlementRepairCandidates()).toEqual([]);
  });

  test("a refund takes back only the period it paid for", async () => {
    const userId = await makeUser();
    const first = new Date(Date.now() + 30 * DAY);
    const second = new Date(Date.now() + 60 * DAY);
    await applyStoreState(
      appleState(userId, {
        transactions: [
          { id: "t1", end: first },
          { id: "t2", end: second },
        ],
      }),
    );
    await applyStoreState(
      appleState(userId, {
        transactions: [{ id: "t2", end: second, revokedAt: new Date() }],
      }),
    );
    expect(await paidUntil(userId)).toEqual(first);
    // A later report without the revocation does not bring it back.
    await applyStoreState(
      appleState(userId, { transactions: [{ id: "t2", end: second }] }),
    );
    expect(await paidUntil(userId)).toEqual(first);

    expect(await revokeStoreTransaction("apple", "t1", new Date())).toBe(true);
    expect(await paidUntil(userId)).toBeNull();
    expect(await checkPaymentInvariants()).toEqual({});
  });

  test("a purchase belongs to the account it was bound to", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const end = new Date(Date.now() + 30 * DAY);
    // Bound to the owner, claimed by another account.
    await expect(
      applyStoreState(
        appleState(owner, { transactions: [{ id: "t1", end }] }),
        {
          claimedBy: other,
        },
      ),
    ).rejects.toBeInstanceOf(StoreOwnershipError);
    // Unbound by the store, held by the owner once claimed.
    await applyStoreState(
      appleState(null, { transactions: [{ id: "t1", end }] }),
      {
        claimedBy: owner,
      },
    );
    await expect(
      applyStoreState(appleState(null, { transactions: [{ id: "t1", end }] }), {
        claimedBy: other,
      }),
    ).rejects.toBeInstanceOf(StoreOwnershipError);
    expect(await paidUntil(other)).toBeNull();
    expect(await paidUntil(owner)).toEqual(end);
  });

  test("a notification applies to the bound account, or waits", async () => {
    const userId = await makeUser();
    const end = new Date(Date.now() + 30 * DAY);
    expect(
      await applyStoreState(
        appleState(null, { key: "orphan", transactions: [{ id: "t9", end }] }),
      ),
    ).toEqual({ applied: false, reason: "unbound" });
    const applied = await applyStoreState(
      appleState(userId, { transactions: [{ id: "t1", end }] }),
    );
    expect(applied).toMatchObject({ applied: true, userId });
    expect(await paidUntil(userId)).toEqual(end);
  });

  test("store time survives a Toss refund recompute", async () => {
    const userId = await makeUser();
    const storeEnd = new Date(Date.now() + 30 * DAY);
    await applyStoreState(
      appleState(userId, { transactions: [{ id: "t1", end: storeEnd }] }),
    );
    await db.transaction().execute((trx) => recomputePaidTime(trx, userId));
    expect(await paidUntil(userId)).toEqual(storeEnd);
  });

  test("one recurring plan at a time across Toss and the stores", async () => {
    const userId = await makeUser();
    expect((await supporterStatus(userId, "apple")).purchase.allowed).toBe(
      true,
    );

    const end = new Date(Date.now() + 30 * DAY);
    await applyStoreState(
      appleState(userId, {
        store: "google",
        key: "token-1",
        transactions: [{ id: "GPA.1", end }],
      }),
    );
    const onIos = await supporterStatus(userId, "apple");
    expect(onIos).toMatchObject({
      supporter: true,
      source: "google",
      purchase: { allowed: false },
    });
    expect((await supporterStatus(userId, "google")).purchase.allowed).toBe(
      false,
    );
    // The web starts no Toss plan beside it.
    const prepared = await prepareSubscription({ userId, interval: "month" });
    expect(prepared).toMatchObject({ ok: false, status: 409 });

    // Canceled in the store: the period runs out, then anything may follow.
    await applyStoreState(
      appleState(userId, {
        store: "google",
        key: "token-1",
        autoRenews: false,
        transactions: [{ id: "GPA.1", end }],
      }),
    );
    expect((await supporterStatus(userId, "google")).purchase.allowed).toBe(
      true,
    );
    // The Play period is store time, not prepaid Toss time.
    expect((await supporterStatus(userId, "apple")).purchase.allowed).toBe(
      true,
    );
    expect(
      await prepareSubscription({ userId, interval: "month" }),
    ).toMatchObject({ ok: true });
  });

  test("prepaid Toss time blocks a store purchase", async () => {
    const userId = await makeUser();
    // As a granted one-time purchase leaves it (lib/payments/paid-time).
    await sql`update users set supporter_until = ${new Date(Date.now() + 100 * DAY)} where id = ${userId}`.execute(
      db,
    );
    const status = await supporterStatus(userId, "apple");
    expect(status).toMatchObject({
      source: "toss",
      purchase: { allowed: false },
    });
  });
  test("an operator moves a subscription to another account", async () => {
    const from = await makeUser();
    const to = await makeUser();
    const past = new Date(Date.now() - 10 * DAY);
    const current = new Date(Date.now() + 20 * DAY);
    const applied = await applyStoreState(
      appleState(from, {
        transactions: [
          { id: "t1", end: past },
          { id: "t2", end: current },
        ],
      }),
      { claimedBy: from },
    );
    if (!applied.applied) throw new Error("not applied");
    const moved = await moveStoreSubscription({
      subscriptionId: applied.subscriptionId,
      toLoginName: await loginOf(to),
      operator: { id: from, loginName: "yang" },
      reason: "같은 사람의 다른 계정",
    });
    expect(moved).toEqual({ from, to, movedUntil: current });
    // The current period goes with it; the one already over stays.
    expect(await paidUntil(from)).toEqual(past);
    expect(await paidUntil(to)).toEqual(current);

    // Renewals follow the subscription, though the store bound it to `from`.
    const renewal = new Date(Date.now() + 50 * DAY);
    await applyStoreState(
      appleState(from, { transactions: [{ id: "t3", end: renewal }] }),
    );
    expect(await paidUntil(to)).toEqual(renewal);
    expect(await paidUntil(from)).toEqual(past);
    // Restoring it is the new owner's, and no longer the old one's.
    await applyStoreState(
      appleState(from, { transactions: [{ id: "t3", end: renewal }] }),
      { claimedBy: to },
    );
    await expect(
      applyStoreState(
        appleState(from, { transactions: [{ id: "t3", end: renewal }] }),
        { claimedBy: from },
      ),
    ).rejects.toBeInstanceOf(StoreOwnershipError);

    const events = await db
      .selectFrom("payment_events")
      .select("user_id")
      .where("kind", "=", "store_moved")
      .execute();
    expect(events.map((event) => event.user_id).sort()).toEqual(
      [from, to].sort(),
    );
    expect(await checkPaymentInvariants()).toEqual({});
  });

  test("a move that would charge twice is refused", async () => {
    const from = await makeUser();
    const to = await makeUser();
    const end = new Date(Date.now() + 20 * DAY);
    const applied = await applyStoreState(
      appleState(from, { transactions: [{ id: "t1", end }] }),
    );
    if (!applied.applied) throw new Error("not applied");
    await applyStoreState(
      appleState(to, {
        store: "google",
        key: "token-2",
        transactions: [{ id: "GPA.2", end }],
      }),
    );
    const move = (toLoginName: string) =>
      moveStoreSubscription({
        subscriptionId: applied.subscriptionId,
        toLoginName,
        operator: { id: from, loginName: "yang" },
        reason: "test",
      });
    await expect(move(await loginOf(to))).rejects.toBeInstanceOf(
      StoreTransferError,
    );
    await expect(move(await loginOf(from))).rejects.toBeInstanceOf(
      StoreTransferError,
    );
    await expect(move("nobody")).rejects.toBeInstanceOf(StoreTransferError);
    expect(await paidUntil(from)).toEqual(end);
  });
});
