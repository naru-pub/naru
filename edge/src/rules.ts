import { createHash } from "node:crypto";
import {
  DataError,
  name,
} from "../../control-plane/src/lib/site-data/validation";
import type { SqlValue } from "./query";

/** A rule returns a predicate, never SQL. SQL applies it before paging/counting. */
export function rulePredicate(value: unknown) {
  const bindings: SqlValue[] = [];
  let nodes = 0;
  function compile(raw: unknown, depth = 0): string {
    if (++nodes > 100 || depth > 10)
      throw new DataError(400, "Rule predicate is too complex.");
    if (raw === true) return "1";
    if (raw === false) return "0";
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new DataError(400, "Invalid rule predicate.");
    const node = raw as Record<string, unknown>;
    const keys = Object.keys(node);
    if (keys.length !== 1) throw new DataError(400, "Invalid rule predicate.");
    if (keys[0] === "all" || keys[0] === "any") {
      const terms = node[keys[0]];
      if (!Array.isArray(terms) || !terms.length)
        throw new DataError(400, "Invalid rule predicate.");
      return `(${terms.map((term) => compile(term, depth + 1)).join(keys[0] === "all" ? " AND " : " OR ")})`;
    }
    if (keys[0] !== "eq" && keys[0] !== "ne")
      throw new DataError(400, "Invalid rule operator.");
    const pair = node[keys[0]];
    if (!Array.isArray(pair) || pair.length !== 2)
      throw new DataError(400, "Invalid rule comparison.");
    const [field, bound] = pair;
    if (
      bound !== null &&
      !["string", "number", "boolean"].includes(typeof bound)
    )
      throw new DataError(400, "Invalid rule value.");
    if (typeof bound === "number" && !Number.isFinite(bound))
      throw new DataError(400, "Invalid rule value.");
    let eq: string;
    if (field && typeof field === "object" && !Array.isArray(field)) {
      if (
        Object.keys(field).length !== 1 ||
        !["id", "createdBy"].includes(field.metadata)
      )
        throw new DataError(400, "Invalid rule metadata.");
      const column = field.metadata === "id" ? "id" : "created_by";
      if (bound !== null && typeof bound !== "string")
        throw new DataError(400, "Invalid rule metadata value.");
      eq = bound === null ? `${column} IS NULL` : `${column} = ?`;
      if (bound !== null) bindings.push(bound);
    } else {
      const path = `'$."${name(field)}"'`;
      const type = `json_type(data, ${path})`;
      if (bound === null) eq = `${type} = 'null'`;
      else if (typeof bound === "boolean")
        eq = `${type} = '${bound ? "true" : "false"}'`;
      else {
        eq = `${type} ${typeof bound === "string" ? "= 'text'" : "IN ('integer', 'real')"} AND json_extract(data, ${path}) = ?`;
        bindings.push(bound as SqlValue);
      }
    }
    return `${keys[0] === "ne" ? "NOT " : ""}coalesce((${eq}), 0)`;
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

export const RULE_WRAPPER = `
export function __naruScope(ctx, args) { return scope(ctx, args); }
export async function __naruWrite(ctx, args) { return (await canWrite(ctx, args)) === true; }
`;
