/** @jest-environment node */
import { afterAll, describe, expect, test } from "@jest/globals";
import { Client } from "pg";
import {
  closeAccountLockPool,
  PAYMENTS_LOCK_SPACE,
  withAccountLock,
} from "@/lib/payments/account-lock";

const integration =
  process.env.NARU_PAYMENTS_DB_TEST === "1" ? describe : describe.skip;

// The account lock's connection sits idle while the operation it guards waits
// on Toss. A connection dropped then (a restart, a failover) must not take the
// process down with an unhandled 'error', and must not leave a pooled client
// that thinks it still holds the lock.
integration("account lock", () => {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });

  afterAll(async () => {
    await admin.end();
    await closeAccountLockPool();
  });

  test("a lock whose connection drops mid-operation does not crash the process", async () => {
    await admin.connect();
    const userId = "0190f0e0-0000-7000-8000-000000000001";
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const result = await withAccountLock(userId, { waitMs: 0 }, async () => {
        // The lock's own backend: the one holding the advisory lock.
        const holder = await admin.query<{ pid: number }>(
          `select pid from pg_locks
           where locktype = 'advisory' and classid = $1::bigint
             and objid = hashtext($2::text)::oid and granted`,
          [PAYMENTS_LOCK_SPACE, userId],
        );
        expect(holder.rows).toHaveLength(1);
        await admin.query("select pg_terminate_backend($1)", [
          holder.rows[0].pid,
        ]);
        // The operation goes on, as one waiting on Toss would.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return "finished";
      });
      expect(result).toBe("finished");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(uncaught).toEqual([]);

    // The lock went with the connection, and the pool hands out working
    // clients that can take it again.
    await expect(
      withAccountLock(userId, { waitMs: 0 }, async () => "again"),
    ).resolves.toBe("again");
  });
});
