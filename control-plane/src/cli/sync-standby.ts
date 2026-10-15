import { db } from "@/lib/database";
import { syncStandby } from "@/lib/edge/standby";

// Copies changed site databases from the mini to the standby on Cloudflare,
// then reports the mini as up. See lib/edge/standby.ts.
async function main() {
  const { sites, copied, failed } = await syncStandby();
  console.log(
    `[standby-sync] ${sites} sites, ${copied.length} copied` +
      (copied.length ? `: ${copied.join(", ")}` : "") +
      (failed.length ? `, failed: ${failed.join(", ")}` : ""),
  );
  if (failed.length) process.exitCode = 1;
}

main().finally(() => db.destroy());
