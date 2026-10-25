// A template's SQL migrations against a site's history (site-code.ts):
// kept apart from the storage and edge calls so they can be tested alone.
import { createHash } from "node:crypto";
import { SITE_CODE_PREFIX } from "./constants";

export const MIGRATIONS_PREFIX = `${SITE_CODE_PREFIX}migrations/`;

/** A site path that is one of its SQL migrations. */
export const isMigration = (path: string) => path.startsWith(MIGRATIONS_PREFIX);

/** A migration's digest, as releases record it. */
export const migrationDigest = (sql: string) =>
  createHash("sha256").update(sql).digest("hex");

const CREATED_TABLE =
  /\bcreate\s+(?:temp(?:orary)?\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi;

/**
 * Why `migrations` (a template's, by name and SQL) cannot run on a site
 * that has run `applied` and has `tables`, for a person to read: one with
 * the name of an applied migration but other SQL, one that sorts before the
 * last applied, or one that makes a table the site already has.
 */
export function migrationConflicts(
  applied: Map<string, string>,
  tables: Set<string>,
  migrations: { name: string; sql: string }[],
): string[] {
  const conflicts: string[] = [];
  const last = [...applied.keys()].sort().at(-1);
  for (const migration of migrations) {
    const digest = applied.get(migration.name);
    if (digest !== undefined) {
      // Run already, as it is: nothing to do.
      if (digest === migrationDigest(migration.sql)) continue;
      conflicts.push(
        `마이그레이션 ${migration.name}: 같은 이름으로 이미 적용된 마이그레이션과 내용이 달라요.`,
      );
      continue;
    }
    if (last !== undefined && migration.name < last) {
      conflicts.push(
        `마이그레이션 ${migration.name}: 이미 적용된 ${last}보다 앞에 와서 적용할 수 없어요.`,
      );
      continue;
    }
    for (const [, table] of migration.sql.matchAll(CREATED_TABLE))
      if (tables.has(table.toLowerCase()))
        conflicts.push(
          `마이그레이션 ${migration.name}: 사이트 데이터베이스에 ${table} 테이블이 이미 있어요.`,
        );
  }
  return conflicts;
}
