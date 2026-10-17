import { parseArgs } from "node:util";
import { REPURGE_AFTER_MS } from "@/lib/cache-purge";
import { db } from "@/lib/database";
import { rewriteStoredSdkUrls } from "@/lib/maintenance/sdk-url-migration";

// Rewrites https://naru.pub/sdk/ (and http://, //) to
// https://sdk.naru.pub/sdk/ in stored site files and template snapshots
// (lib/maintenance/sdk-url-migration.ts says which, and what else it does).
//
// Usage:
//   node dist/cli/rewrite-sdk-urls.mjs              → dry run: what would change
//   node dist/cli/rewrite-sdk-urls.mjs --apply      → rewrite
//   node dist/cli/rewrite-sdk-urls.mjs --site <login> [--apply]
//   --concurrency <n>   files read at once per site (default 8)
//
// Idempotent: a rewritten file no longer matches.
async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      site: { type: "string" },
      concurrency: { type: "string", default: "8" },
    },
  });
  if (values.apply && values["dry-run"])
    throw new Error("--apply and --dry-run are exclusive");
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
    throw new Error("--concurrency must be 1..64");
  const apply = values.apply;

  console.log(
    `[rewrite-sdk-urls] ${apply ? "APPLY" : "dry run (pass --apply to write)"}` +
      (values.site ? `, site ${values.site}` : ", every site"),
  );
  const report = await rewriteStoredSdkUrls({
    apply,
    site: values.site,
    concurrency,
  });

  console.log("[rewrite-sdk-urls] by site:");
  for (const [site, { files, matches }] of report.bySite)
    console.log(`  ${site}: ${files} file(s), ${matches} match(es)`);
  const count = (outcome: string) =>
    report.files.filter((file) => file.outcome === outcome).length;
  const matches = report.files.reduce((sum, file) => sum + file.count, 0);
  console.log(
    `[rewrite-sdk-urls] ${report.files.length} file(s) with ${matches} match(es) ` +
      `in ${report.bySite.size} site(s)/template(s); ` +
      (apply
        ? `${count("rewritten")} rewritten, ${count("changed")} changed since read (rerun)`
        : `${count("would-rewrite")} would be rewritten`) +
      `, ${count("reported")} in site code (_naru/, not rewritten); ` +
      `${report.scanned} read, ${report.skipped} skipped, ${report.failed.length} failed`,
  );
  if (report.failed.length) process.exitCode = 1;

  // purgeSiteObjects purges again after REPURGE_AFTER_MS, on a timer that
  // does not hold the process open: stay for it.
  if (count("rewritten") > 0) {
    console.log("[rewrite-sdk-urls] waiting for the second cache purge");
    await new Promise((resolve) =>
      setTimeout(resolve, REPURGE_AFTER_MS + 2000),
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
