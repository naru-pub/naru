import { createHash } from "node:crypto";
import {
  DataError,
  name,
} from "../../control-plane/src/lib/site-data/validation";
import type { SqlValue } from "./query";

const COMPARE: Record<string, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/**
 * A predicate, never SQL: what a rule's `scope` returns, and what a list's
 * `where` asks for. Built from `all` and `any` of comparisons: `eq`, `ne`,
 * `gt`, `gte`, `lt` and `lte` take `[field, value]`, and `in` takes
 * `[field, [value, ...]]`. A field is a top-level data field by name, or
 * `{ metadata: "id" | "createdBy" }`. Values are strings, finite numbers,
 * booleans or null, and match only their own JSON type; ranges take strings or
 * numbers. SQL applies it before paging and counting.
 */
export function predicate(value: unknown, what = "Rule predicate") {
  const bindings: SqlValue[] = [];
  let nodes = 0;
  const invalid = (detail: string) => new DataError(400, `${what}: ${detail}`);
  function scalar(bound: unknown) {
    if (
      !(
        bound === null ||
        typeof bound === "string" ||
        typeof bound === "boolean" ||
        (typeof bound === "number" && Number.isFinite(bound))
      ) ||
      (typeof bound === "string" &&
        (bound.includes("\u0000") || !bound.isWellFormed()))
    )
      throw invalid("values are strings, finite numbers, booleans or null.");
    return bound as string | number | boolean | null;
  }
  function comparison(field: unknown, operator: string, raw: unknown) {
    const bound = scalar(raw);
    if (
      operator !== "eq" &&
      typeof bound !== "string" &&
      typeof bound !== "number"
    )
      throw invalid(`${operator} compares strings or numbers.`);
    const sign = operator === "eq" ? "=" : COMPARE[operator];
    if (field && typeof field === "object" && !Array.isArray(field)) {
      const metadata = (field as { metadata?: unknown }).metadata;
      if (
        Object.keys(field).length !== 1 ||
        (metadata !== "id" && metadata !== "createdBy")
      )
        throw invalid('metadata fields are "id" and "createdBy".');
      const column = metadata === "id" ? "id" : "created_by";
      if (bound === null && operator === "eq") return `${column} IS NULL`;
      if (typeof bound !== "string")
        throw invalid("metadata values are strings.");
      bindings.push(bound);
      return `${column} ${sign} ?`;
    }
    const path = `'$."${name(field)}"'`;
    const type = `json_type(data, ${path})`;
    if (bound === null) return `${type} = 'null'`;
    if (typeof bound === "boolean")
      return `${type} = '${bound ? "true" : "false"}'`;
    bindings.push(bound);
    return `${type} ${typeof bound === "string" ? "= 'text'" : "IN ('integer', 'real')"} AND json_extract(data, ${path}) ${sign} ?`;
  }
  function compile(raw: unknown, depth = 0): string {
    if (++nodes > 100 || depth > 10) throw invalid("too complex.");
    if (raw === true) return "1";
    if (raw === false) return "0";
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw invalid("expected true, false or one operator.");
    const node = raw as Record<string, unknown>;
    const keys = Object.keys(node);
    if (keys.length !== 1) throw invalid("expected one operator per object.");
    const [operator] = keys;
    if (operator === "all" || operator === "any") {
      const terms = node[operator];
      if (!Array.isArray(terms) || !terms.length)
        throw invalid(`${operator} takes a non-empty list.`);
      return `(${terms.map((term) => compile(term, depth + 1)).join(operator === "all" ? " AND " : " OR ")})`;
    }
    const pair = node[operator];
    if (!Array.isArray(pair) || pair.length !== 2)
      throw invalid(`${operator} takes [field, value].`);
    const [field, bound] = pair;
    if (operator === "in") {
      if (!Array.isArray(bound) || !bound.length || bound.length > 100)
        throw invalid("in takes [field, [1 to 100 values]].");
      return `coalesce((${bound.map((item) => `(${comparison(field, "eq", item)})`).join(" OR ")}), 0)`;
    }
    if (operator === "ne")
      return `NOT coalesce((${comparison(field, "eq", bound)}), 0)`;
    if (operator !== "eq" && !Object.hasOwn(COMPARE, operator))
      throw invalid(`unknown operator ${operator}.`);
    return `coalesce((${comparison(field, operator, bound)}), 0)`;
  }
  const sql = compile(value);
  return {
    sql,
    bindings,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(value))
      .digest("base64url"),
  };
}

/** What a rule's `scope` returned, as SQL. */
export const rulePredicate = (value: unknown) => predicate(value);

/**
 * The module a rule runs from: it imports the owner's `_naru/rules/<file>.js`
 * from the function revision, so a rule can import `_naru/modules/` like a
 * function. Its name holds a colon, which no published path can, so it never
 * meets one of the owner's modules.
 */
export function ruleEntry(path: string) {
  return {
    filename: "rules/:naru",
    source: `import * as rules from "./${path.slice("rules/".length)}";
export async function __naruScope(ctx, args) { return rules.scope(ctx, args); }
export async function __naruWrite(ctx, args) { return (await rules.canWrite(ctx, args)) === true; }
`,
  };
}
