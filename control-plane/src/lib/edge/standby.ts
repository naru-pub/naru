import { db } from "@/lib/database";
import {
  callSiteObjectAt,
  edgeWorker,
  sendStandbyHeartbeat,
  siteDataWorker,
} from "@/lib/edge/client";

// The standby: every site's database lives on the mini (edge/src/seoul.ts),
// and a copy of each is kept on Cloudflare, which serves visitors read-only
// while the mini is away (edge/src/standby.ts). Each minute, sites whose data
// changed since their last copy are copied again, whole: a site's
// fingerprint names what it holds, and the mini records which fingerprint
// Cloudflare has. Then the mini reports in, so the health check on
// Cloudflare knows it is up even when its probes cannot reach it.

type Fingerprint = {
  fingerprint: string;
  collections: number;
  documents: number;
  standby: string | null;
};

/**
 * The sites that can hold data: every account that ever had the database
 * feature (supporters, past and present, complimentary plans) or has
 * documents counted.
 */
export async function sitesWithData() {
  return (
    await db
      .selectFrom("users")
      .select("login_name")
      .where("deleted_at", "is", null)
      .where((eb) =>
        eb.or([
          eb("supporter_comp", "=", true),
          eb("supporter_until", "is not", null),
          eb("site_data_document_count", ">", "0"),
        ]),
      )
      .orderBy("login_name")
      .execute()
  ).map((row) => row.login_name);
}

export async function syncStandby() {
  const mini = siteDataWorker();
  const cloudflare = edgeWorker();
  if (!mini.base || mini.base === cloudflare.base)
    throw new Error("SITE_DATA_URL does not name the mini's Worker.");
  const counts: Record<string, { collections: number; documents: number }> = {};
  const copied: string[] = [];
  const failed: string[] = [];
  for (const site of await sitesWithData()) {
    try {
      const now = await callSiteObjectAt<Fingerprint>(
        mini,
        site,
        "fingerprint",
        {},
      );
      counts[site] = {
        collections: now.collections,
        documents: now.documents,
      };
      if (now.fingerprint === now.standby) continue;
      const dump = await callSiteObjectAt(mini, site, "dump", {});
      await callSiteObjectAt(cloudflare, site, "replace", dump);
      // If the site changed after `fingerprint`, the next run sees it still
      // differs and copies it again.
      await callSiteObjectAt(mini, site, "markStandby", {
        fingerprint: now.fingerprint,
      });
      copied.push(site);
    } catch (error) {
      failed.push(site);
      console.error(`[standby-sync] ${site} failed:`, error);
    }
  }
  await sendStandbyHeartbeat({ sites: counts });
  return { sites: Object.keys(counts).length, copied, failed };
}
