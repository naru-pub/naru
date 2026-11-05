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
  // A plan with other features takes more than a key here: features are read
  // from the account's newest subscription row, ended or not yet charged, and
  // paid time (users.supporter_until) does not record which plan bought it.
};

// What a free trial opens: the plan's features but custom domains, since
// Cloudflare bills every hostname until long after a trial ends
// (lib/custom-domain-housekeeping). A plan started during the trial, whose
// first charge waits for its end, opens them too.
export const TRIAL_FEATURES: Feature[] = PLAN_FEATURES.supporter.filter(
  (feature) => feature !== "custom_domains",
);

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
  /** In a trial with a plan whose first charge waits for the trial's end. */
  planWaitingOnTrial: boolean;
  /** Whether any of the plan's features are open: a supporter, or in a trial. */
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
// A free trial opens TRIAL_FEATURES without making the user a supporter:
// payment code reads isSupporter, access reads hasPaidFeatures and featuresOf.
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
      "subscriptions.status as planStatus",
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
      planWaitingOnTrial: false,
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
    planWaitingOnTrial: inTrial && row.planStatus === "scheduled",
    hasPaidFeatures: isSupporter || inTrial,
    accessEndsAt,
  };
}

/** The features an entitlement opens. */
export function featuresOf(entitlement: UserEntitlement): Feature[] {
  if (entitlement.isSupporter || entitlement.planWaitingOnTrial)
    return PLAN_FEATURES[entitlement.plan ?? "supporter"] ?? [];
  return entitlement.inTrial ? TRIAL_FEATURES : [];
}

/**
 * When an account's custom domains stop being served, epoch ms, for queries
 * over many accounts that cannot resolve each one: null for a comp, whose
 * features do not end; 0 when it never had them. A free trial alone does not
 * count, since it does not open custom domains. With a plan waiting on it, the
 * trial's end counts as paid time does, grace included, so the domain is still
 * served while the first charge settles; a canceled plan or a declined charge
 * takes the plan out of "scheduled" and closes it at the next sync.
 */
export function customDomainAccessEndsAt(row: {
  supporter_comp: boolean;
  supporter_until: Date | string | null;
  supporter_grace: boolean;
  trial_ends_at: Date | string | null;
  plan_status: string | null;
}): number | null {
  if (row.supporter_comp) return null;
  const paid = row.supporter_until
    ? paidAccessEndsAt(
        new Date(row.supporter_until),
        row.supporter_grace,
      ).getTime()
    : 0;
  const waiting =
    row.trial_ends_at && row.plan_status === "scheduled"
      ? paidAccessEndsAt(new Date(row.trial_ends_at), true).getTime()
      : 0;
  return Math.max(paid, waiting);
}

// Resolves every feature at once. The nav needs the whole set on every page
// load, and calling userHasFeature per feature would repeat the same
// entitlement lookup once for each of them.
export async function getUserFeatures(userId: string): Promise<Set<Feature>> {
  return new Set(featuresOf(await getUserEntitlement(userId)));
}

export async function userHasFeature(
  userId: string,
  feature: Feature,
  executor: Executor = db,
): Promise<boolean> {
  return featuresOf(await getUserEntitlement(userId, executor)).includes(
    feature,
  );
}
