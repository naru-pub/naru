import { createHash } from "node:crypto";
import { db } from "@/lib/database";
import type { Executor } from "@/lib/entitlements";
import { withAccountLock } from "@/lib/payments/account-lock";

// A free trial of the supporter plan: its features but custom domains
// (TRIAL_FEATURES) for TRIAL_DAYS, claimed on /supporter by an account with a
// verified email that has never paid and has no comp; an account that lacks
// only the verified email is offered it and asked for one. One per account and one
// per address (supporter_trials), so deleting an account and signing up again
// with the address does not claim another. It is not paid time: it never
// enters users.supporter_until, the payment ledger or refunds, and isSupporter
// stays false through it. What it changes is access (getUserEntitlement's
// hasPaidFeatures and accessEndsAt) and when a plan started during it is first
// charged: at its end.

export const TRIAL_DAYS = 7;

/** The form of an address compared between claims: trimmed and lowercased. */
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

/**
 * What supporter_trials keeps of the address that claimed, named by its
 * method. The addresses are not kept, so old digests cannot be recomputed:
 * to change the method, add one here and write new claims with it, while
 * claimedDigests keeps listing every method ever used, so old rows (those of
 * deleted accounts among them) still count.
 */
export function emailDigest(email: string) {
  return `sha256:${createHash("sha256").update(normalizeEmail(email)).digest("hex")}`;
}

/** The address's digest under every method claims were ever written with. */
function claimedDigests(email: string) {
  return [emailDigest(email)];
}

/** When the account's trial ends (or ended); null when it never claimed one. */
export async function trialEndsAt(
  executor: Executor,
  userId: string,
): Promise<Date | null> {
  const row = await executor
    .selectFrom("supporter_trials")
    .select("ends_at")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row ? new Date(row.ends_at) : null;
}

/** The later of two moments, either of which may be missing. */
export function laterOf(
  a: Date | string | null | undefined,
  b: Date | string | null | undefined,
): Date | null {
  const x = a ? new Date(a) : null;
  const y = b ? new Date(b) : null;
  if (!x) return y;
  if (!y) return x;
  return x > y ? x : y;
}

export type TrialState =
  | { state: "active"; endsAt: Date }
  | { state: "ended"; endsAt: Date }
  | { state: "eligible" }
  // May claim once its email is verified.
  | { state: "unverified" }
  | { state: "ineligible"; message: string };

/** Whether the account has, had or may claim a trial, and why not. */
export async function trialState(
  executor: Executor,
  userId: string,
  now = new Date(),
): Promise<TrialState> {
  const endsAt = await trialEndsAt(executor, userId);
  if (endsAt)
    return endsAt > now
      ? { state: "active", endsAt }
      : { state: "ended", endsAt };
  const user = await executor
    .selectFrom("users")
    .select(["email", "email_verified_at", "supporter_comp", "deleted_at"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!user || user.deleted_at)
    return { state: "ineligible", message: "계정을 찾을 수 없습니다." };
  if (user.supporter_comp)
    return {
      state: "ineligible",
      message: "이미 유료 기능을 무료로 제공받고 있습니다.",
    };
  // Any charge, settled or in flight, and any store purchase: the trial is
  // for accounts that have not paid before.
  const paid = await executor
    .selectFrom("payments")
    .select("id")
    .where("user_id", "=", userId)
    .where("status", "in", ["pending", "done", "canceled"])
    .executeTakeFirst();
  const store = await executor
    .selectFrom("store_subscriptions")
    .select("id")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (paid || store)
    return {
      state: "ineligible",
      message: "무료 체험은 결제한 적이 없는 계정만 시작할 수 있습니다.",
    };
  if (!user.email || !user.email_verified_at) return { state: "unverified" };
  const claimed = await executor
    .selectFrom("supporter_trials")
    .select("id")
    .where("email_digest", "in", claimedDigests(user.email))
    .executeTakeFirst();
  if (claimed)
    return {
      state: "ineligible",
      message: "이 이메일 주소로 이미 무료 체험을 사용했습니다.",
    };
  return { state: "eligible" };
}

export class TrialError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "TrialError";
  }
}

/**
 * Claims the account's trial, which ends TRIAL_DAYS from now. Under the
 * account lock (lib/payments/account-lock), so no charge or signup decides
 * meanwhile whether the account has paid or when its plan starts.
 */
export async function claimTrial(userId: string, now = new Date()) {
  return withAccountLock(userId, { waitMs: 10_000 }, () =>
    db.transaction().execute(async (trx) => {
      const state = await trialState(trx, userId, now);
      if (state.state === "active" || state.state === "ended")
        throw new TrialError("이미 무료 체험을 사용했습니다.", 409);
      if (state.state === "ineligible")
        throw new TrialError(state.message, 403);
      if (state.state === "unverified")
        throw new TrialError(
          "무료 체험은 이메일을 인증한 계정만 시작할 수 있습니다.",
          403,
        );
      const user = await trx
        .selectFrom("users")
        .select("email")
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();
      const endsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
      // The unique columns settle a claim by another account with the same
      // address racing this one.
      const row = await trx
        .insertInto("supporter_trials")
        .values({
          user_id: userId,
          email_digest: emailDigest(user.email!),
          claimed_at: now,
          ends_at: endsAt,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning("ends_at")
        .executeTakeFirst();
      if (!row)
        throw new TrialError(
          "이 이메일 주소로 이미 무료 체험을 사용했습니다.",
          409,
        );
      return { endsAt: new Date(row.ends_at) };
    }),
  );
}
