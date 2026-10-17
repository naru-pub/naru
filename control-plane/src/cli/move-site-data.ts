import { parseArgs } from "node:util";
import { db } from "@/lib/database";
import { edgeWorker, type WorkerTarget } from "@/lib/edge/client";
import { copySiteData, DumpSummary, summarizeDump } from "@/lib/edge/dumps";

// Moves site databases from the edge Worker on Cloudflare (EDGE_WORKER_URL)
// to the one beside this control plane (SITE_DATA_URL, edge/src/seoul.ts):
// each site's whole object is dumped there and restored here, the dump piped
// straight through (lib/edge/dumps.ts) and summarized on the way, and the
// copy's dump compared with it table by table. Run it during the cutover,
// with the data API in maintenance so nothing writes meanwhile. A site that
// already has collections here is refused, never overwritten.
//
//   node dist/cli/move-site-data.mjs [--site <login name>] [--dry-run]
//
// Only accounts that ever had the database feature can hold data: supporters,
// past and present, complimentary plans, and any with documents counted.

const countsOf = (tables: Record<string, { rows: number }>) =>
  Object.entries(tables)
    .map(([name, table]) => `${name} ${table.rows}`)
    .join(", ");

async function main() {
  const { values } = parseArgs({
    options: {
      site: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const from = edgeWorker();
  const to: WorkerTarget = {
    base: process.env.SITE_DATA_URL,
    secret: process.env.SITE_DATA_SECRET ?? process.env.EDGE_WORKER_SECRET,
  };
  if (!to.base || to.base === from.base)
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
      const before = await summarizeDump(from, site);
      if (!Object.keys(before.tables).length) {
        empty++;
        continue;
      }
      if (values["dry-run"]) {
        console.log(
          `[move-site-data] ${site}: would move ${countsOf(before.tables)}`,
        );
        continue;
      }
      const sent = new DumpSummary();
      await copySiteData(from, to, site, "restore", (chunk) =>
        sent.push(chunk),
      );
      const original = sent.finish();
      const copy = (await summarizeDump(to, site)).tables;
      const differing = [
        ...new Set([...Object.keys(original), ...Object.keys(copy)]),
      ].filter(
        (name) =>
          original[name]?.digest !== copy[name]?.digest ||
          original[name]?.rows !== copy[name]?.rows,
      );
      if (differing.length)
        throw new Error(`the copy differs in ${differing.join(", ")}`);
      moved++;
      console.log(`[move-site-data] ${site}: moved ${countsOf(original)}`);
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
