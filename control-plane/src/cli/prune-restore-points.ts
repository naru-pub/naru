import { pruneRestorePoints } from "@/lib/site-functions/restore-points";
import {
  restorePointStorage,
  runtimeSites,
} from "@/lib/site-functions/storage";

// Deletes restore points past their week (RESTORE_POINT_DAYS) for every site
// with a `_naru-runtime/<site>/` folder in the site bucket: only keys under
// its `restore-points/`. A site's object also prunes its own each time it
// writes one; this catches the sites that stopped writing them. The nightly
// B2 backup keeps what is deleted here for about 30 days more.
async function main() {
  let deleted = 0;
  const failed: string[] = [];
  for (const site of await runtimeSites()) {
    try {
      const removed = await pruneRestorePoints(restorePointStorage, site);
      if (removed.length)
        console.log(
          `[restore-point-retention] ${site}: deleted ${removed.join(", ")}`,
        );
      deleted += removed.length;
    } catch (error) {
      failed.push(site);
      console.error(`[restore-point-retention] ${site} failed:`, error);
    }
  }
  console.log(
    `[restore-point-retention] ${deleted} deleted` +
      (failed.length ? `, failed: ${failed.join(", ")}` : ""),
  );
  if (failed.length) process.exitCode = 1;
}

void main();
