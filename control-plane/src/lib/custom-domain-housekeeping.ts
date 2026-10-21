import { sql } from "kysely";
import { db } from "@/lib/database";
import { deleteCloudflareCustomHostnameIfExists } from "@/lib/customDomains";
import { accessEndsAtOf } from "@/lib/entitlements";
import { pushEdgeDomainsSoon } from "@/lib/edge/domains";
import { mailRecipient } from "@/lib/payments/payment-mails";
import { sendCustomDomainReleaseNoticeEmail } from "@/lib/email";

// Cloudflare bills every custom hostname, served or not, so a domain that no
// longer serves anyone is released: its Cloudflare hostname is deleted and
// its row kept, marked released, so the owner can connect it again in one step
// from /domains (a new hostname, whose records Cloudflare may ask for again).
// Another account may take a released hostname (the custom-domains route).
//
// A domain is released, for the first reason that applies:
//   lapsed:  its owner's paid access, grace and trial ended LAPSED_DAYS ago
//   pending: it has not validated within PENDING_DAYS of being added
//   dns:     its DNS has not reached Naru for DNS_DAYS (lib/edge/domain-dns.ts)
// and never sooner than NOTICE_DAYS after its owner was told by mail. The
// notice is withdrawn once the reason no longer applies, so a later lapse is
// told again. Released rows are deleted after PURGE_DAYS.
//
// Runs every 30 minutes as the custom-domain-housekeeping job. Each run sends at most
// MAX_NOTICES mails (Resend takes a few a second) and releases at most
// MAX_RELEASES domains (Cloudflare allows 1,200 calls in five minutes), most
// overdue first, within BUDGET_MS; the rest wait for the next run.

const DAY_MS = 24 * 60 * 60 * 1000;
export const LAPSED_DAYS = 30;
export const PENDING_DAYS = 14;
export const DNS_DAYS = 30;
export const NOTICE_DAYS = 7;
const PURGE_DAYS = 365;
const MAX_NOTICES = 50;
const MAX_RELEASES = 100;
const BUDGET_MS = 240_000;

export type ReleaseReason = "lapsed" | "pending" | "dns";

export type HousekeepingRow = {
  createdAt: Date;
  active: boolean;
  dnsFailingSince: Date | null;
  /** When the owner's paid access ends, epoch ms; null never. */
  accessEndsAt: number | null;
  noticeSentAt: Date | null;
};

/**
 * Why and when the domain is due to be released, or null while it is not:
 * `due` is when the reason allows it, `releaseAt` when it happens given the
 * notice (null until the notice is sent).
 */
export function releaseSchedule(row: HousekeepingRow, now = Date.now()) {
  let reason: ReleaseReason;
  let due: number;
  if (row.accessEndsAt !== null && row.accessEndsAt <= now) {
    reason = "lapsed";
    due = row.accessEndsAt + LAPSED_DAYS * DAY_MS;
  } else if (!row.active) {
    reason = "pending";
    due = row.createdAt.getTime() + PENDING_DAYS * DAY_MS;
  } else if (row.dnsFailingSince) {
    reason = "dns";
    due = row.dnsFailingSince.getTime() + DNS_DAYS * DAY_MS;
  } else {
    return null;
  }
  return {
    reason,
    noticeAt: due - NOTICE_DAYS * DAY_MS,
    releaseAt: row.noticeSentAt
      ? new Date(
          Math.max(due, row.noticeSentAt.getTime() + NOTICE_DAYS * DAY_MS),
        )
      : null,
  };
}

/** Every domain not released, with what its schedule needs; `userId`'s only. */
export async function housekeepingRows(userId?: string) {
  let query = db
    .selectFrom("custom_domains")
    .innerJoin("users", "users.id", "custom_domains.user_id")
    .select([
      "custom_domains.id",
      "custom_domains.user_id",
      "custom_domains.hostname",
      "custom_domains.cloudflare_hostname_id",
      "custom_domains.created_at",
      "custom_domains.verified_at",
      "custom_domains.cloudflare_status",
      "custom_domains.ssl_status",
      "custom_domains.dns_failing_since",
      "custom_domains.release_notice_sent_at",
      "users.supporter_comp",
      "users.supporter_until",
      "users.supporter_grace",
      (eb) =>
        eb
          .selectFrom("supporter_trials")
          .select((t) => t.fn.max("supporter_trials.ends_at").as("ends_at"))
          .whereRef("supporter_trials.user_id", "=", "users.id")
          .as("trial_ends_at"),
    ])
    .where("custom_domains.released_at", "is", null)
    .where("users.deleted_at", "is", null);
  if (userId) query = query.where("custom_domains.user_id", "=", userId);
  return (await query.execute()).map((row) => ({
    id: row.id,
    userId: row.user_id,
    hostname: row.hostname,
    cloudflareHostnameId: row.cloudflare_hostname_id,
    createdAt: new Date(row.created_at),
    active:
      row.verified_at !== null &&
      row.cloudflare_status === "active" &&
      row.ssl_status === "active",
    dnsFailingSince: row.dns_failing_since
      ? new Date(row.dns_failing_since)
      : null,
    accessEndsAt: accessEndsAtOf(row),
    noticeSentAt: row.release_notice_sent_at
      ? new Date(row.release_notice_sent_at)
      : null,
  }));
}

export type HousekeepingDeps = {
  now?: number;
  /** Mails the owner; false when there is no one to mail. */
  notify?: (
    userId: string,
    notice: { hostname: string; reason: ReleaseReason; releaseAt: Date },
  ) => Promise<boolean>;
  deleteHostname?: (cloudflareHostnameId: string) => Promise<void>;
};

async function notifyOwner(
  userId: string,
  notice: { hostname: string; reason: ReleaseReason; releaseAt: Date },
) {
  const to = await mailRecipient(userId);
  if (!to) return false;
  await sendCustomDomainReleaseNoticeEmail({
    email: to.email,
    loginName: to.loginName,
    ...notice,
  });
  return true;
}

export async function runCustomDomainHousekeeping({
  now = Date.now(),
  notify = notifyOwner,
  deleteHostname = deleteCloudflareCustomHostnameIfExists,
}: HousekeepingDeps = {}) {
  const deadline = Date.now() + BUDGET_MS;
  const result = { notices: 0, withdrawn: 0, released: 0, purged: 0 };
  const rows = (await housekeepingRows())
    .map((row) => ({ row, schedule: releaseSchedule(row, now) }))
    .sort(
      (a, b) =>
        (a.schedule?.noticeAt ?? Infinity) - (b.schedule?.noticeAt ?? Infinity),
    );

  // Reasons that no longer apply: their notices are withdrawn at once.
  const withdrawn = rows
    .filter(({ row, schedule }) => !schedule && row.noticeSentAt)
    .map(({ row }) => row.id);
  if (withdrawn.length) {
    await db
      .updateTable("custom_domains")
      .set({ release_notice_sent_at: null })
      .where("id", "in", withdrawn)
      .execute();
    result.withdrawn = withdrawn.length;
  }

  for (const { row, schedule } of rows) {
    if (!schedule || Date.now() >= deadline) break;
    if (!row.noticeSentAt) {
      if (now < schedule.noticeAt || result.notices >= MAX_NOTICES) continue;
      const releaseAt = new Date(
        Math.max(
          schedule.noticeAt + NOTICE_DAYS * DAY_MS,
          now + NOTICE_DAYS * DAY_MS,
        ),
      );
      try {
        // Without a verified address no one can be told; the release still
        // waits the notice period.
        if (
          !(await notify(row.userId, {
            hostname: row.hostname,
            reason: schedule.reason,
            releaseAt,
          }))
        )
          console.warn(
            `[custom-domain-housekeeping] ${row.hostname}: no verified address to notify`,
          );
      } catch (error) {
        console.error(
          `[custom-domain-housekeeping] ${row.hostname}: notice failed; trying next run`,
          error,
        );
        continue;
      }
      await db
        .updateTable("custom_domains")
        .set({ release_notice_sent_at: new Date(now) })
        .where("id", "=", row.id)
        .execute();
      result.notices++;
      continue;
    }
    if (
      !schedule.releaseAt ||
      now < schedule.releaseAt.getTime() ||
      result.released >= MAX_RELEASES
    )
      continue;
    try {
      // Cloudflare first: should the update not follow, the next run deletes
      // again (a hostname already gone is fine) and records it.
      if (row.cloudflareHostnameId)
        await deleteHostname(row.cloudflareHostnameId);
    } catch (error) {
      console.error(
        `[custom-domain-housekeeping] ${row.hostname}: Cloudflare delete failed; trying next run`,
        error,
      );
      continue;
    }
    await db
      .updateTable("custom_domains")
      .set({
        released_at: new Date(now),
        release_reason: schedule.reason,
        release_notice_sent_at: null,
        cloudflare_hostname_id: null,
        cloudflare_status: "released",
        ssl_status: null,
        ownership_verification_name: null,
        ownership_verification_type: null,
        ownership_verification_value: null,
        ssl_validation_records: null,
        verification_errors: null,
        verified_at: null,
        dns_resolves: false,
        dns_checked_at: null,
        dns_failing_since: null,
        updated_at: new Date(now),
      })
      .where("id", "=", row.id)
      .where("released_at", "is", null)
      .execute();
    result.released++;
    console.log(
      `[custom-domain-housekeeping] ${row.hostname}: released (${schedule.reason})`,
    );
  }
  // A released domain that was served (dns) leaves the edge at once.
  if (result.released) await pushEdgeDomainsSoon();

  const purged = await db
    .deleteFrom("custom_domains")
    .where(
      "released_at",
      "<",
      sql<Date>`${new Date(now)}::timestamptz - make_interval(days => ${PURGE_DAYS})`,
    )
    .executeTakeFirst();
  result.purged = Number(purged.numDeletedRows);
  return result;
}
