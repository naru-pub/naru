import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { db } from "@/lib/database";
import {
  callSiteObjectAt,
  edgeWorker,
  siteDataWorker,
} from "@/lib/edge/client";

// Moves site databases from the edge Worker on Cloudflare (EDGE_WORKER_URL)
// to the one beside this control plane (SITE_DATA_URL, edge/src/seoul.ts):
// each site's whole object is dumped there, restored here, and the copy
// compared with the original table by table. Run it during the cutover, with
// the data API in maintenance so nothing writes meanwhile. A site that already
// has collections here is refused, never overwritten.
//
//   node dist/cli/move-site-data.mjs [--site <login name>] [--dry-run]
//
// Only accounts that ever had the database feature can hold data: supporters,
// past and present, complimentary plans, and any with documents counted.

type Dump = { tables: Record<string, Record<string, unknown>[]> };

/** A table's rows in an order-free form, so two dumps compare equal. */
const fingerprint = (rows: Record<string, unknown>[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        rows
          .map((row) =>
            JSON.stringify(
              Object.keys(row)
                .sort()
                .map((key) => [key, row[key]]),
            ),
          )
          .sort(),
      ),
    )
    .digest("hex");

async function main() {
  const { values } = parseArgs({
    options: {
      site: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const from = edgeWorker();
  const to = siteDataWorker();
  if (!process.env.SITE_DATA_URL || to.base === from.base)
    throw new Error(
      "Set SITE_DATA_URL to the Worker beside this control plane.",
    );
  const sites = values.site
    ? [values.site]
    : (
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

  let moved = 0;
  let empty = 0;
  const failed: string[] = [];
  for (const site of sites) {
    try {
      const dump = await callSiteObjectAt<Dump>(from, site, "dump", {});
      const rows = Object.values(dump.tables).reduce(
        (sum, table) => sum + table.length,
        0,
      );
      if (!rows) {
        empty++;
        continue;
      }
      const counts = Object.entries(dump.tables)
        .filter(([, table]) => table.length)
        .map(([name, table]) => `${name} ${table.length}`)
        .join(", ");
      if (values["dry-run"]) {
        console.log(`[move-site-data] ${site}: would move ${counts}`);
        continue;
      }
      await callSiteObjectAt(to, site, "restore", dump);
      const copy = await callSiteObjectAt<Dump>(to, site, "dump", {});
      const differing = Object.keys(dump.tables).filter(
        (name) =>
          fingerprint(dump.tables[name]) !==
          fingerprint(copy.tables[name] ?? []),
      );
      if (differing.length)
        throw new Error(`the copy differs in ${differing.join(", ")}`);
      moved++;
      console.log(`[move-site-data] ${site}: moved ${counts}`);
    } catch (error) {
      failed.push(site);
      console.error(`[move-site-data] ${site} failed:`, error);
    }
  }
  console.log(
    `[move-site-data] ${moved} moved, ${empty} empty, ${failed.length} failed` +
      (failed.length ? `: ${failed.join(", ")}` : ""),
  );
  if (failed.length) process.exitCode = 1;
}

main().finally(() => db.destroy());
