import { randomBytes } from "crypto";
import { db } from "@/lib/database";
import type { User } from "@/lib/auth";
import { BoardError } from "@/lib/board/board-error";
import type { Executor } from "@/lib/entitlements";
import { enqueueJob } from "@/lib/payments/payment-jobs";
import {
  deleteSeller,
  getSeller,
  TossApiError,
  isDefinitiveTossFailure,
  registerSeller,
  updateSeller,
  type TossSeller,
} from "@/lib/payments/toss";
import { BANKS } from "./constants";
import {
  isOneOf,
  OPEN_PAYOUT_STATUSES,
  SELLER_BUSINESS_TYPES,
  SELLER_STATUSES,
  type SellerBusinessType,
  type SellerStatus,
} from "./states";

// An author who sells templates is registered at Toss as a payout seller
// (지급대행 셀러). Toss checks the account and the business number, and an
// individual verifies their identity through the message Toss sends them;
// until then the seller is APPROVAL_REQUIRED and nothing is paid out, though
// sales go on. 나루 keeps only what it shows back: the name, the bank, the
// account's last four digits.

export interface SellerSummary {
  id: string;
  businessType: SellerBusinessType;
  status: SellerStatus;
  displayName: string;
  bankCode: string;
  accountLast4: string;
  holderName: string;
  registered: boolean;
}

export async function findSeller(userId: string) {
  return db
    .selectFrom("market_sellers")
    .selectAll()
    .where("user_id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

export function summarize(
  row: NonNullable<Awaited<ReturnType<typeof findSeller>>>,
): SellerSummary {
  return {
    id: row.id,
    businessType: row.business_type,
    status: row.status,
    displayName: row.display_name,
    bankCode: row.bank_code,
    accountLast4: row.account_last4,
    holderName: row.holder_name,
    registered: row.toss_seller_id !== null,
  };
}

// Whether the user may put a price on a template: registered at Toss.
export async function canSell(userId: string): Promise<boolean> {
  const seller = await findSeller(userId);
  return !!seller?.toss_seller_id;
}

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new BoardError(400, `${field}을(를) 확인해 주세요.`);
  }
  return value.trim();
};
const digits = (value: unknown, field: string, min: number, max: number) => {
  const raw = typeof value === "string" ? value.replace(/[\s-]/g, "") : "";
  if (!/^\d+$/.test(raw) || raw.length < min || raw.length > max) {
    throw new BoardError(400, `${field}을(를) 확인해 주세요.`);
  }
  return raw;
};
const email = (value: unknown) => {
  const address = text(value, "이메일", 100);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new BoardError(400, "이메일을 확인해 주세요.");
  }
  return address;
};

export interface SellerAccountInput {
  bankCode: string;
  accountNumber: string;
  holderName: string;
}

function validateAccount(input: Record<string, unknown>): SellerAccountInput {
  const bankCode = typeof input.bankCode === "string" ? input.bankCode : "";
  if (!BANKS.some((bank) => bank.code === bankCode)) {
    throw new BoardError(400, "은행을 골라 주세요.");
  }
  return {
    bankCode,
    accountNumber: digits(input.accountNumber, "계좌번호", 6, 14),
    holderName: text(input.holderName, "예금주", 50),
  };
}

function validateRegistration(input: Record<string, unknown>) {
  if (!isOneOf(SELLER_BUSINESS_TYPES, input.businessType)) {
    throw new BoardError(400, "사업자 유형을 골라 주세요.");
  }
  const businessType = input.businessType;
  const account = validateAccount(input);
  const contact = {
    email: email(input.email),
    phone: digits(input.phone, "전화번호", 8, 15),
  };
  if (businessType === "INDIVIDUAL") {
    const name = text(input.name, "이름", 50);
    return {
      businessType,
      displayName: name,
      account,
      individual: { name, ...contact },
    };
  }
  const representativeName = text(input.representativeName, "대표자 이름", 50);
  const companyName =
    typeof input.companyName === "string" && input.companyName.trim()
      ? text(input.companyName, "상호", 100)
      : undefined;
  return {
    businessType,
    displayName: companyName ?? representativeName,
    account,
    company: {
      ...(companyName ? { name: companyName } : {}),
      representativeName,
      businessRegistrationNumber: digits(
        input.businessRegistrationNumber,
        "사업자등록번호",
        10,
        10,
      ),
      ...contact,
    },
  };
}

// Toss's answer to a registration it refused, as the person can act on it.
function refusal(error: unknown): BoardError {
  if (isDefinitiveTossFailure(error)) {
    return new BoardError(
      400,
      `토스페이먼츠가 정산 정보를 받지 않았어요: ${error.message}`,
    );
  }
  return new BoardError(
    503,
    "토스페이먼츠에 정산 정보를 보내지 못했어요. 잠시 후 다시 시도해 주세요.",
  );
}

// "naru" and ten random characters: 7 to 20 characters, Toss's bounds, and
// nothing about the person.
function newRefSellerId(): string {
  return `naru${randomBytes(8).toString("base64url").slice(0, 10)}`;
}

/**
 * Registers the user as a seller at Toss, or finishes a registration whose
 * answer was lost: the row is written first with its refSellerId, which
 * Toss's idempotency key is made of. A refusal gives it a new one.
 */
export async function registerAsSeller(
  user: User,
  input: Record<string, unknown>,
): Promise<SellerSummary> {
  if (!user.emailVerifiedAt) {
    throw new BoardError(403, "템플릿을 팔려면 먼저 이메일을 인증해 주세요.");
  }
  const registration = validateRegistration(input);
  const existing = await db
    .selectFrom("market_sellers")
    .selectAll()
    .where("user_id", "=", user.id)
    .executeTakeFirst();
  if (existing?.toss_seller_id) {
    throw new BoardError(409, "이미 판매자로 등록했어요.");
  }
  const values = {
    business_type: registration.businessType,
    display_name: registration.displayName,
    bank_code: registration.account.bankCode,
    account_last4: registration.account.accountNumber.slice(-4),
    holder_name: registration.account.holderName,
    updated_at: new Date(),
  };
  const row = existing
    ? await db
        .updateTable("market_sellers")
        .set(values)
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow()
    : await db
        .insertInto("market_sellers")
        .values({
          ...values,
          user_id: user.id,
          ref_seller_id: newRefSellerId(),
        })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((error) => {
          // The same form sent twice at once: the other request registers.
          const { code, constraint } = (error ?? {}) as {
            code?: string;
            constraint?: string;
          };
          if (code === "23505" && constraint === "market_sellers_user_id_key")
            throw new BoardError(
              409,
              "판매자 등록을 처리하고 있어요. 잠시 후 새로고침해 주세요.",
            );
          throw error;
        });

  let seller: TossSeller;
  try {
    seller = await registerSeller({
      refSellerId: row.ref_seller_id,
      businessType: registration.businessType,
      ...("individual" in registration
        ? { individual: registration.individual }
        : { company: registration.company }),
      account: registration.account,
      metadata: { userId: user.id },
    });
  } catch (error) {
    // Toss keeps a refused registration's answer under its idempotency key:
    // corrected details go under a new refSellerId, and so a new key. One
    // whose answer was lost keeps its own, to get that answer back.
    if (isDefinitiveTossFailure(error)) {
      await db
        .updateTable("market_sellers")
        .set({ ref_seller_id: newRefSellerId(), updated_at: new Date() })
        .where("id", "=", row.id)
        .where("toss_seller_id", "is", null)
        .execute();
    }
    throw refusal(error);
  }
  const registered = await db
    .updateTable("market_sellers")
    .set({
      toss_seller_id: seller.id,
      status: isOneOf(SELLER_STATUSES, seller.status)
        ? seller.status
        : "APPROVAL_REQUIRED",
      synced_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return summarize(registered);
}

// A new account for payouts. Toss checks it as at registration; an
// individual's status may go back to APPROVAL_REQUIRED.
export async function changeSellerAccount(
  user: User,
  input: Record<string, unknown>,
): Promise<SellerSummary> {
  const seller = await findSeller(user.id);
  if (!seller?.toss_seller_id) {
    throw new BoardError(404, "판매자로 등록하지 않았어요.");
  }
  const account = validateAccount(input);
  let updated: TossSeller;
  try {
    updated = await updateSeller(seller.toss_seller_id, { account });
  } catch (error) {
    throw refusal(error);
  }
  const row = await db
    .updateTable("market_sellers")
    .set({
      bank_code: account.bankCode,
      account_last4: account.accountNumber.slice(-4),
      holder_name: account.holderName,
      ...(isOneOf(SELLER_STATUSES, updated.status)
        ? { status: updated.status }
        : {}),
      synced_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", seller.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return summarize(row);
}

// Toss's word on a seller's status: from the seller.changed webhook, which
// is only a notice, and from the seller's own page.
export async function syncSeller(
  tossSellerId: string,
): Promise<SellerStatus | null> {
  const seller = await getSeller(tossSellerId);
  if (!isOneOf(SELLER_STATUSES, seller.status)) return null;
  await db
    .updateTable("market_sellers")
    .set({ status: seller.status, synced_at: new Date() })
    .where("toss_seller_id", "=", tossSellerId)
    .execute();
  return seller.status;
}

// Account deletion (lib/account-deletion), in its transaction: what 나루
// keeps of the seller is wiped, they get no further payouts, and their
// registration at Toss goes once any payout already under way is done.
// The row stays for the sales and payouts that name it.
export async function retireSeller(
  trx: Executor,
  userId: string,
): Promise<void> {
  const seller = await trx
    .updateTable("market_sellers")
    .set({
      display_name: "탈퇴한 판매자",
      holder_name: "",
      account_last4: "",
      deleted_at: new Date(),
      updated_at: new Date(),
    })
    .where("user_id", "=", userId)
    .returning("id")
    .executeTakeFirst();
  if (!seller) return;
  await enqueueJob(
    trx,
    { kind: "deregister_seller", sellerId: seller.id },
    { dedupeKey: `seller-deregister:${seller.id}` },
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The task retireSeller queues: waits a day at a time while a payout to the
// seller is still open, then deletes them at Toss.
export async function deregisterSeller(sellerId: string): Promise<void> {
  const seller = await db
    .selectFrom("market_sellers")
    .select(["toss_seller_id", "deleted_at"])
    .where("id", "=", sellerId)
    .executeTakeFirstOrThrow();
  if (!seller.toss_seller_id || !seller.deleted_at) return;
  const open = await db
    .selectFrom("seller_payouts")
    .select("id")
    .where("seller_id", "=", sellerId)
    .where("status", "in", OPEN_PAYOUT_STATUSES)
    .executeTakeFirst();
  if (open) {
    const runAt = new Date(Date.now() + DAY_MS);
    await enqueueJob(
      db,
      { kind: "deregister_seller", sellerId },
      {
        runAt,
        dedupeKey: `seller-deregister:${sellerId}:${runAt.toISOString().slice(0, 10)}`,
      },
    );
    return;
  }
  try {
    await deleteSeller(seller.toss_seller_id);
  } catch (error) {
    // Already gone at Toss.
    if (!(error instanceof TossApiError && error.status === 404)) throw error;
  }
  // Gone at Toss: what the nightly check (market/invariants) looks for.
  await db
    .updateTable("market_sellers")
    .set({ toss_seller_id: null, updated_at: new Date() })
    .where("id", "=", sellerId)
    .execute();
}
