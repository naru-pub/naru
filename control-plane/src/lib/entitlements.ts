import type { Kysely } from "kysely";
import { db } from "@/lib/database";
import type { DB } from "@/lib/db";
import { isCurrentPlan, paidAccessEndsAt } from "@/lib/payments/subscriptions";

/**
 * Callers already inside a transaction must pass their own `tx`. Reaching for
 * the pool from inside a held transaction takes a second connection while the
 * first is still checked out, and enough concurrent callers doing that empty
 * the pool with every one of them waiting on it.
 */
export type Executor = Kysely<DB>;

// Features that a paid (supporter) plan can unlock. Add new features here as
// they become gated.
export type Feature =
  "custom_domains" | "github_deploys" | "analytics" | "database";

export const ALL_FEATURES: Feature[] = [
  "custom_domains",
  "github_deploys",
  "analytics",
  "database",
];

// Shown wherever a feature has to be named to a person — the refund screens and
// the operator listing both spell out which 유료 기능 an account touched.
export const FEATURE_LABELS: Record<Feature, string> = {
  custom_domains: "커스텀 도메인",
  github_deploys: "GitHub 배포",
  analytics: "방문자 현황",
  database: "데이터베이스",
};

export const PLAN_FEATURES: Record<string, Feature[]> = {
  supporter: ["custom_domains", "github_deploys", "analytics", "database"],
  // To add a richer tier later, add another plan key with its feature list.
};

export type UserEntitlement = {
  isSupporter: boolean;
  comp: boolean;
  /** Paid through a date still in the future, before any grace window. */
  paid: boolean;
  plan: string | null;
  supporterUntil: Date | null;
  graceEndsAt: Date | null;
  inPaymentGrace: boolean;
  /** When a free trial (lib/supporter-trial.ts) ends or ended; null without one. */
  trialEndsAt: Date | null;
  inTrial: boolean;
  /** Whether the plan's features are open: a supporter, or in a trial. */
  hasPaidFeatures: boolean;
  /**
   * When the features close, past or future: the later of the payment grace
   * and the trial's end. Null for a comp, whose features do not end, and for
   * an account that never had them.
   */
  accessEndsAt: Date | null;
};

// Resolves a user's current entitlement. A user is a supporter if they have a
// permanent comp or a paid-through date that has not passed the grace window,
// when it has one.
// A free trial opens the same features without making the user a supporter:
// payment code reads isSupporter, access reads hasPaidFeatures.
export async function getUserEntitlement(
  userId: string,
  executor: Executor = db,
): Promise<UserEntitlement> {
  const row = await executor
    .selectFrom("users")
    .leftJoin("subscriptions", (join) =>
      join.onRef("subscriptions.user_id", "=", "users.id").on(isCurrentPlan),
    )
    .leftJoin("supporter_trials", "supporter_trials.user_id", "users.id")
    .select([
      "users.supporter_comp as comp",
      "users.supporter_until as supporterUntil",
      "users.supporter_grace as grace",
      "subscriptions.plan as plan",
      "supporter_trials.ends_at as trialEndsAt",
    ])
    .where("users.id", "=", userId)
    .where("users.deleted_at", "is", null)
    .executeTakeFirst();

  if (!row) {
    return {
      isSupporter: false,
      comp: false,
      paid: false,
      plan: null,
      supporterUntil: null,
      graceEndsAt: null,
      inPaymentGrace: false,
      trialEndsAt: null,
      inTrial: false,
      hasPaidFeatures: false,
      accessEndsAt: null,
    };
  }

  const comp = !!row.comp;
  const supporterUntil = row.supporterUntil
    ? new Date(row.supporterUntil)
    : null;
  // Without a grace window (users.supporter_grace) it ends with the paid time.
  const graceEndsAt = supporterUntil
    ? paidAccessEndsAt(supporterUntil, row.grace)
    : null;
  const paid = supporterUntil != null && supporterUntil.getTime() > Date.now();
  const inPaymentGrace =
    !paid && graceEndsAt != null && graceEndsAt.getTime() > Date.now();
  const isSupporter = comp || paid || inPaymentGrace;
  const trialEndsAt = row.trialEndsAt ? new Date(row.trialEndsAt) : null;
  const inTrial = trialEndsAt != null && trialEndsAt.getTime() > Date.now();
  // Comp and trial users have no subscription row, so default them to the
  // supporter plan.
  const plan = row.plan ?? (comp || inTrial ? "supporter" : null);
  let accessEndsAt: Date | null = null;
  if (!comp)
    for (const end of [graceEndsAt, trialEndsAt])
      if (end && (!accessEndsAt || end > accessEndsAt)) accessEndsAt = end;

  return {
    isSupporter,
    comp,
    paid,
    plan,
    supporterUntil,
    graceEndsAt,
    inPaymentGrace,
    trialEndsAt,
    inTrial,
    hasPaidFeatures: isSupporter || inTrial,
    accessEndsAt,
  };
}

/**
 * When an account's features close, epoch ms, from its users columns and its
 * trial's end, for queries over many accounts that cannot resolve each one:
 * null for a comp, whose features do not end; 0 when it never had them.
 * The rule getUserEntitlement's accessEndsAt applies.
 */
export function accessEndsAtOf(row: {
  supporter_comp: boolean;
  supporter_until: Date | string | null;
  supporter_grace: boolean;
  trial_ends_at: Date | string | null;
}): number | null {
  if (row.supporter_comp) return null;
  const paid = row.supporter_until
    ? paidAccessEndsAt(
        new Date(row.supporter_until),
        row.supporter_grace,
      ).getTime()
    : 0;
  const trial = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : 0;
  return Math.max(paid, trial);
}

// Resolves every feature at once. The nav needs the whole set on every page
// load, and calling userHasFeature per feature would repeat the same
// entitlement lookup once for each of them.
export async function getUserFeatures(userId: string): Promise<Set<Feature>> {
  const ent = await getUserEntitlement(userId);
  if (!ent.hasPaidFeatures) return new Set();
  return new Set(PLAN_FEATURES[ent.plan ?? "supporter"] ?? []);
}

export async function userHasFeature(
  userId: string,
  feature: Feature,
  executor: Executor = db,
): Promise<boolean> {
  const ent = await getUserEntitlement(userId, executor);
  if (!ent.hasPaidFeatures) return false;
  const planFeatures = PLAN_FEATURES[ent.plan ?? "supporter"] ?? [];
  return planFeatures.includes(feature);
}
