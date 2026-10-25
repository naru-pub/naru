import { sql } from "kysely";
import { db } from "@/lib/database";
import { BoardError } from "./board-error";

// Applying or updating a template changes a site's files in several steps
// (back up, copy, publish the site's code, record the install), and putting
// them back after a failure assumes nothing else changed them meanwhile. So
// one runs at a time per site: a second, from a double click or another
// tab, is refused rather than interleaved.
//
// The lock is a PostgreSQL session advisory lock on a connection held for
// the operation, which keeps using `db` for its own queries. A process that
// dies releases it with its connection.
export const TEMPLATE_LOCK_SPACE = 0x54504c31; // "TPL1"

export async function withSiteLock<T>(
  userId: string,
  work: () => Promise<T>,
): Promise<T> {
  return await db.connection().execute(async (connection) => {
    const { rows } = await sql<{
      locked: boolean;
    }>`select pg_try_advisory_lock(${TEMPLATE_LOCK_SPACE}, hashtext(${userId})) as locked`.execute(
      connection,
    );
    if (!rows[0]?.locked)
      throw new BoardError(
        409,
        "이 사이트에 템플릿을 적용하고 있어요. 끝난 뒤에 다시 해 주세요.",
      );
    try {
      return await work();
    } finally {
      await sql`select pg_advisory_unlock(${TEMPLATE_LOCK_SPACE}, hashtext(${userId}))`.execute(
        connection,
      );
    }
  });
}
