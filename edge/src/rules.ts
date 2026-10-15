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
 * `gt`, `gte`, `lt` and `lte` take `[field, value]`, `in` takes
 * `[field, [value, ...]]`, `has` takes `[field, value]` and matches an
 * array field holding that value, and `contains` takes `[field, text]` and
 * matches a string field with that text in it (A–Z in either case). A field is a top-level data field by name, or
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
    if (operator === "has") {
      // An array of scalars holding the value, matched by JSON type as eq is.
      if (field && typeof field === "object")
        throw invalid("has takes a data field, not metadata.");
      const path = `'$."${name(field)}"'`;
      const item = scalar(bound);
      let match: string;
      if (item === null) match = "type = 'null'";
      else if (typeof item === "boolean")
        match = `type = '${item ? "true" : "false"}'`;
      else {
        bindings.push(item);
        match = `type ${typeof item === "string" ? "= 'text'" : "IN ('integer', 'real')"} AND value = ?`;
      }
      return `coalesce((json_type(data, ${path}) = 'array' AND EXISTS (SELECT 1 FROM json_each(data, ${path}) WHERE ${match})), 0)`;
    }
    if (operator === "contains") {
      // Text within a string field: a board's search, say. instr, not LIKE,
      // so % and _ are only characters; lower() folds A–Z alone.
      if (field && typeof field === "object")
        throw invalid("contains takes a data field, not metadata.");
      if (
        typeof bound !== "string" ||
        !bound ||
        bound.length > 100 ||
        bound.includes("\u0000") ||
        !bound.isWellFormed()
      )
        throw invalid("contains takes [field, text of 1–100 characters].");
      const path = `'$."${name(field)}"'`;
      bindings.push(bound);
      return `coalesce((json_type(data, ${path}) = 'text' AND instr(lower(json_extract(data, ${path})), lower(?)) > 0), 0)`;
    }
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

/** What a rule's `scope` returned, as SQL; `what` names it in errors. */
export const rulePredicate = (value: unknown, what?: string) =>
  predicate(value, what);

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
export async function __naruScope(ctx, args) {
  if (typeof rules.scope !== "function") throw new Error("it exports no scope function.");
  return rules.scope(ctx, args);
}
// true, or what canWrite gave instead, for the refusal to quote.
export async function __naruWrite(ctx, args) {
  if (typeof rules.canWrite !== "function") return "no canWrite function";
  const allowed = await rules.canWrite(ctx, args);
  if (allowed === true) return true;
  const shown = allowed === undefined ? "undefined" : JSON.stringify(allowed) ?? String(allowed);
  return "canWrite returned " + (shown.length > 60 ? shown.slice(0, 60) + "…" : shown);
}
export function __naruView() {
  if (typeof rules.present !== "function") return null;
  const fields = rules.queryable ?? [];
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string"))
    throw new Error("queryable must be a list of field names.");
  return fields;
}
export async function __naruPresent(ctx, args) {
  const shown = [];
  for (const document of args.documents)
    shown.push(await rules.present(ctx, { collection: args.collection, document }));
  return shown;
}
`,
  };
}

/**
 * The user fields a read's filter, `where` and sort name. A rule that trims
 * documents (`present`) allows only its `queryable` ones, so a caller cannot
 * probe hidden values by asking which documents match them.
 */
export function queriedFields(input: {
  filter?: unknown;
  where?: unknown;
  sort?: string;
}) {
  const fields = new Set<string>();
  if (input.filter && typeof input.filter === "object")
    for (const key of Object.keys(input.filter)) fields.add(key);
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [operator, value] of Object.entries(node)) {
      if (operator === "all" || operator === "any") {
        if (Array.isArray(value)) value.forEach(walk);
      } else if (Array.isArray(value) && typeof value[0] === "string")
        fields.add(value[0]);
    }
  };
  walk(input.where);
  if (input.sort !== undefined) {
    let sort: unknown;
    try {
      sort = JSON.parse(input.sort);
    } catch {
      sort = null;
    }
    if (Array.isArray(sort))
      for (const item of sort)
        if (Array.isArray(item) && typeof item[0] === "string")
          fields.add(item[0]);
  }
  return [...fields];
}

/** What `present` returned for one document: its data as the caller sees it. */
export function presented(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DataError(
      400,
      "Collection rule present() must return the document's data as an object.",
    );
  return value as Record<string, unknown>;
}
