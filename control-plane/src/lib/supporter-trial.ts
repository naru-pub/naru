import { createHash } from "node:crypto";
import { db } from "@/lib/database";
import type { Executor } from "@/lib/entitlements";
import { withAccountLock } from "@/lib/payments/account-lock";

// A free trial of the supporter plan: its features for TRIAL_DAYS, claimed
// on /supporter by an account with a verified email that has never paid and
// has no comp, while a claim window operators opened on /admin/trials is
// open (supporter_trial_windows). Windows only decide when a trial may be
// claimed; an account or address that had one never claims another. One per account and one per address (supporter_trials), so
// deleting an account and signing up again with the address does not claim
// another. It is not paid time: it never enters users.supporter_until, the
// payment ledger or refunds, and isSupporter stays false through it. What it
// changes is access (getUserEntitlement's hasPaidFeatures and accessEndsAt)
// and when a plan started during it is first charged: at its end.

export const TRIAL_DAYS = 30;

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

/** The claim window open at `now`, the one open longest if several are. */
export async function openTrialWindow(executor: Executor, now = new Date()) {
  const row = await executor
    .selectFrom("supporter_trial_windows")
    .select(["id", "ends_at"])
    .where("starts_at", "<=", now)
    .where("ends_at", ">", now)
    .orderBy("ends_at", "desc")
    .executeTakeFirst();
  return row ? { id: row.id, endsAt: new Date(row.ends_at) } : null;
}

export type TrialState =
  | { state: "active"; endsAt: Date }
  | { state: "ended"; endsAt: Date }
  | { state: "eligible"; window: { id: string; endsAt: Date } }
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
  const window = await openTrialWindow(executor, now);
  if (!window)
    return {
      state: "ineligible",
      message: "지금은 무료 체험을 신청받지 않습니다.",
    };
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
  if (!user.email || !user.email_verified_at)
    return {
      state: "ineligible",
      message: "무료 체험은 이메일을 인증한 계정만 시작할 수 있습니다.",
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
  return { state: "eligible", window };
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
          window_id: state.window.id,
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

export type TrialWindow = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  note: string;
  createdBy: string;
  claims: number;
};

/** Every claim window, latest first, with how many trials each was claimed in. */
export async function listTrialWindows(): Promise<TrialWindow[]> {
  const rows = await db
    .selectFrom("supporter_trial_windows as w")
    .leftJoin("supporter_trials as t", "t.window_id", "w.id")
    .select(({ fn }) => [
      "w.id",
      "w.starts_at",
      "w.ends_at",
      "w.note",
      "w.created_by",
      fn.count<string>("t.id").as("claims"),
    ])
    .groupBy("w.id")
    .orderBy("w.starts_at", "desc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    note: row.note,
    createdBy: row.created_by,
    claims: Number(row.claims),
  }));
}

/** An operator's window from a request body, or what is wrong with it. */
export function parseTrialWindow(
  body: Record<string, unknown>,
): { startsAt: Date; endsAt: Date; note: string } | string {
  const time = (value: unknown) =>
    typeof value === "string" && value ? new Date(value) : null;
  const startsAt = time(body.startsAt);
  const endsAt = time(body.endsAt);
  if (!startsAt || !endsAt || isNaN(+startsAt) || isNaN(+endsAt))
    return "시작과 끝을 입력해 주세요.";
  if (endsAt <= startsAt) return "끝은 시작보다 뒤여야 해요.";
  const note = body.note ?? "";
  if (typeof note !== "string" || note.length > 200)
    return "메모는 200자까지 쓸 수 있어요.";
  return { startsAt, endsAt, note: note.trim() };
}

export async function createTrialWindow(
  window: { startsAt: Date; endsAt: Date; note: string },
  operator: string,
) {
  await db
    .insertInto("supporter_trial_windows")
    .values({
      starts_at: window.startsAt,
      ends_at: window.endsAt,
      note: window.note,
      created_by: operator,
    })
    .execute();
}

/** Closes an open window now; false when it was not open. */
export async function endTrialWindow(id: string, now = new Date()) {
  const result = await db
    .updateTable("supporter_trial_windows")
    .set({ ends_at: now })
    .where("id", "=", id)
    .where("starts_at", "<", now)
    .where("ends_at", ">", now)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/**
 * Removes a window nobody claimed in; false otherwise. One with claims stays,
 * as the record of what they were claimed in: end it instead.
 */
export async function deleteTrialWindow(id: string) {
  const result = await db
    .deleteFrom("supporter_trial_windows")
    .where("id", "=", id)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("supporter_trials")
            .select("id")
            .whereRef(
              "supporter_trials.window_id",
              "=",
              "supporter_trial_windows.id",
            ),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}
