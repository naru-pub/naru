import { parseArgs } from "node:util";
import { db } from "@/lib/database";
import {
  callSiteObjectAt,
  edgeWorker,
  type WorkerTarget,
} from "@/lib/edge/client";

// Erases the copies of site databases left on Cloudflare once every site
// lives on the mini (move-site-data.ts). Permanent: run it only after the
// move is verified and the copies are archived. A site is erased only when
// its copy on the mini has its collections, or Cloudflare's copy was empty,
// so nothing that has not moved is lost.
//
//   node dist/cli/erase-cloudflare-site-data.mjs [--site <login name>] --yes

type Dump = { tables: Record<string, unknown[]> };

async function main() {
  const { values } = parseArgs({
    options: {
      site: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  if (!values.yes)
    throw new Error("This erases data for good: pass --yes to go ahead.");
  const cloudflare = edgeWorker();
  const mini: WorkerTarget = {
    base: process.env.SITE_DATA_URL,
    secret: process.env.SITE_DATA_SECRET ?? process.env.EDGE_WORKER_SECRET,
  };
  if (!mini.base || mini.base === cloudflare.base)
    throw new Error("Set SITE_DATA_URL to the Worker on the mini.");
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
  let erased = 0;
  const kept: string[] = [];
  for (const site of sites) {
    const old = await callSiteObjectAt<Dump>(cloudflare, site, "dump", {});
    const rows = Object.values(old.tables).reduce((n, t) => n + t.length, 0);
    if (!rows) continue;
    const copy = await callSiteObjectAt<Dump>(mini, site, "dump", {});
    if (old.tables.collections.length && !copy.tables.collections.length) {
      kept.push(site);
      console.error(
        `[erase-cloudflare-site-data] ${site}: not on the mini, kept`,
      );
      continue;
    }
    await callSiteObjectAt(cloudflare, site, "erase", {});
    erased++;
    console.log(`[erase-cloudflare-site-data] ${site}: erased (${rows} rows)`);
  }
  console.log(
    `[erase-cloudflare-site-data] ${erased} erased` +
      (kept.length ? `, kept: ${kept.join(", ")}` : ""),
  );
  if (kept.length) process.exitCode = 1;
}

main().finally(() => db.destroy());
