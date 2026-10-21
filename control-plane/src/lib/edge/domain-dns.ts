import { Resolver } from "node:dns/promises";
import { sql } from "kysely";
import { db } from "@/lib/database";
import { getCustomDomainTarget } from "@/lib/customDomains";

// Whether each served custom domain's DNS reaches Naru: some address it
// resolves to is one of the custom domain target's. A CNAME to the target and
// an apex ALIAS the registrar flattens both resolve to the target's Cloudflare
// addresses; a domain whose records were removed, or never added, does not.
// A domain on its owner's own Cloudflare zone, proxied to the target, resolves
// to that zone's addresses instead, so when its addresses are someone else's
// the domain is asked over HTTPS which site it serves (the edge answers
// SITE_PROBE_PATH on every host it serves): reaching Naru is serving its site.
// Only a domain that resolves has its site's subdomain redirect to it
// (domains.ts) and is shown in the prompt, so neither sends anyone to an
// address that does not open.
//
// edge-sync runs this every five minutes. A domain not yet found to resolve is
// looked up on every run, so it starts redirecting minutes after its records
// are added; one that resolves is looked up again hourly, since one rarely
// stops. A lookup that gets no answer (a timeout, a resolver failure) changes
// nothing, and the run stops looking past its budget, so a slow resolver
// never holds up the sync. A domain that keeps failing is released after a
// while (lib/custom-domain-housekeeping.ts), from dns_failing_since.

const RECHECK_RESOLVING = "1 hour";
const LOOKUP_TIMEOUT_MS = 3_000;
const BUDGET_MS = 20_000;
const CONCURRENCY = 20;

/** The domain's IPv4 addresses; [] when it has none; null without an answer. */
export type Lookup = (hostname: string) => Promise<string[] | null>;
/** Whether the domain serves the site over HTTPS; null without an answer. */
export type Probe = (
  hostname: string,
  login: string,
) => Promise<boolean | null>;

/** edge/src/index.ts answers it with the site the host serves. */
const SITE_PROBE_PATH = "/.well-known/naru-site";
const PROBE_TIMEOUT_MS = 5_000;

async function probeSite(hostname: string, login: string) {
  try {
    const response = await fetch(`https://${hostname}${SITE_PROBE_PATH}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok && (await response.text()).trim() === login;
  } catch (error) {
    // A timeout is no answer; a refused connection or a certificate that is
    // not ours is one.
    return (error as Error).name === "TimeoutError" ? null : false;
  }
}

const NO_RECORDS = new Set(["ENODATA", "ENOTFOUND"]);

function publicResolver(): Lookup {
  const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  return async (hostname) => {
    try {
      return await resolver.resolve4(hostname);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code && NO_RECORDS.has(code) ? [] : null;
    }
  };
}

/** Looks up the domains due for a check; returns how many were answered. */
export async function checkCustomDomainDns(
  lookup: Lookup = publicResolver(),
  probe: Probe = probeSite,
) {
  const due = await db
    .selectFrom("custom_domains")
    .innerJoin("users", "users.id", "custom_domains.user_id")
    .select(["custom_domains.id", "hostname", "users.login_name"])
    .where("verified_at", "is not", null)
    .where("cloudflare_status", "=", "active")
    .where("ssl_status", "=", "active")
    .where((eb) =>
      eb.or([
        eb("dns_resolves", "=", false),
        eb("dns_checked_at", "is", null),
        eb(
          "dns_checked_at",
          "<",
          sql<Date>`now() - ${RECHECK_RESOLVING}::interval`,
        ),
      ]),
    )
    .orderBy("dns_checked_at", sql`asc nulls first`)
    .execute();
  if (due.length === 0) return 0;
  const target = await lookup(getCustomDomainTarget());
  // Without the target's addresses nothing can be judged: keep what is known.
  if (!target?.length) return 0;
  const targetAddresses = new Set(target);
  const deadline = Date.now() + BUDGET_MS;
  let next = 0;
  let answered = 0;
  const work = async () => {
    while (next < due.length && Date.now() < deadline) {
      const domain = due[next++];
      const addresses = await lookup(domain.hostname);
      if (addresses === null) continue;
      const resolves = addresses.some((a) => targetAddresses.has(a))
        ? true
        : addresses.length
          ? await probe(domain.hostname, domain.login_name)
          : false;
      if (resolves === null) continue;
      await db
        .updateTable("custom_domains")
        .set({
          dns_resolves: resolves,
          dns_checked_at: new Date(),
          // Since when it has not, for housekeeping to release it.
          dns_failing_since: resolves
            ? null
            : sql<Date>`coalesce(dns_failing_since, now())`,
        })
        .where("custom_domains.id", "=", domain.id)
        .execute();
      answered++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  return answered;
}
