import { DataError } from "../../control-plane/src/lib/site-data/validation";

// A site SQL statement's plan, costed before it runs (sql.ts, site.ts). The
// mini's runtime has no CPU limit and a statement cannot be stopped once it
// runs, so a statement whose work could grow faster than the tables it reads
// is refused from its EXPLAIN QUERY PLAN.
//
// The rule: a statement's cost grows at most linearly with table sizes. Each
// step of the plan has a degree, the power of a table's size its rows grow
// by: 0 when bounded by a key or by a value already in hand, 1 when
// proportional to a table. Nested loops multiply, so their degrees add, and
// the statement is allowed when no path adds up to more than 1.
//
//   degree 0  SEARCH by equality on the row ID, a primary key or any index
//             (each `=` column), SCAN CONSTANT ROW, a VALUES clause,
//             json_each/json_tree (one bound value or one row's column), a
//             full-text table found by rowid
//   degree 1  SCAN of a table or index, SEARCH by a range (<, >, BETWEEN, a
//             LIKE prefix, a skip-scan) or with no constraint, a full-text
//             table read whole or searched (MATCH, LIKE, GLOB: any of these
//             can return every row), an IN list read from a table
//
// Combined: steps under one parent are nested loops in join order (their
// degrees add); a correlated subquery runs once per row of the loops around
// it (its degree adds to theirs); a subquery, CTE or automatic index made
// once (MATERIALIZE, SCALAR/LIST SUBQUERY, AUTOMATIC ... INDEX, BLOOM
// FILTER) costs its own degree once, and reading its result costs what made
// it; a co-routine's steps run as its result is read; MULTI-INDEX OR, a
// compound SELECT's parts and a RIGHT JOIN's last pass cost the most of
// theirs. Inside a correlated subquery everything is counted once per outer
// row, as the plan does not say what SQLite makes only once there.
//
// A step of any other shape is refused: what this does not know, it does not
// guess at.
//
// The known gap: an `=` on an index that is not unique counts as degree 0,
// though one value may match many rows (posts p1 JOIN posts p2 ON p2.board =
// p1.board is near quadratic when one board holds most posts). A call's
// MAX_ROWS_READ (sql.ts) is then the backstop, counted after each statement.

/** A step of EXPLAIN QUERY PLAN. */
export type PlanStep = { id: number; parent: number; detail: string };

const invalid = (message: string) =>
  new DataError(400, `Invalid SQL: ${message}`, "INVALID_REQUEST");

/** A table, alias or result name as EXPLAIN QUERY PLAN prints it. */
const NAME = String.raw`(\(subquery-\d+\)|[^\s()]+)`;
const ACCESS = new RegExp(
  String.raw`^(SCAN|SEARCH) ${NAME}( EXISTS)?(?: USING (COVERING INDEX \S+|INDEX \S+|INTEGER PRIMARY KEY|PRIMARY KEY|AUTOMATIC (?:PARTIAL )?(?:COVERING )?INDEX))?(?: \((.+)\))?( LEFT-JOIN)?$`,
);
const VIRTUAL = new RegExp(
  String.raw`^SCAN ${NAME} VIRTUAL TABLE INDEX (\d+):(\S*)( LEFT-JOIN)?$`,
);
/** One column's (or a row value's) equality: `board=?`, `<expr>=?`, `(a,b)=(?,?)`. */
const EQUAL =
  /^(?:[^\s<>=!()]+|<expr>|\([^\s<>=!()]+(?:,[^\s<>=!()]+)*\))=(?:\?|\((?:\?,)*\?\))$/;
/** fts5's index string: MATCH, LIKE and GLOB by column, rank, rowid bounds. */
const FTS = /^(?:r|[MLG]\d+|=|<|>)*$/;

type Degree = number;

/** Who multiplies a group's steps: the loops around it. */
type Around = {
  /** Degree of the loops around the group, per run of it. */
  degree: Degree;
  /** The first of them that reads in proportion to a table. */
  by?: string;
  /** Whether those loops are outside a correlated subquery. */
  subquery: boolean;
  /** What to do instead, when they are what multiplies. */
  advice?: string;
};

/** A loop in a group: its name, degree, and how it reads (for messages). */
type Loop = {
  name: string;
  degree: Degree;
  /** What it does in proportion to a table, as a message says it. */
  reads: string;
  advice: string;
  /** Found by equality: an IN list can drive it, once per value. */
  lookup: boolean;
  /** A co-routine run as it is read. */
  coroutine?: PlanStep;
};

/**
 * Refuses a plan whose cost could grow faster than the tables it reads, with
 * a message naming the loop that multiplies and what it multiplies.
 */
export function checkPlan(plan: PlanStep[]) {
  const children = new Map<number, PlanStep[]>();
  for (const step of plan) {
    const list = children.get(step.parent) ?? [];
    list.push(step);
    children.set(step.parent, list);
  }
  const under = (step: PlanStep) => children.get(step.id) ?? [];
  cost(children.get(0) ?? [], { degree: 0, subquery: false });

  function refuse(around: Around, loops: Loop[], loop: Loop): never {
    const before = loops.find((other) => other !== loop && other.degree > 0);
    const subject = before || !around.subquery ? "it" : "a subquery";
    const by = before?.name ?? around.by ?? loop.name;
    const advice = (!before && around.advice) || loop.advice;
    throw invalid(
      `${subject} would ${loop.reads} for every row of ${by}; ${advice}.`,
    );
  }

  /** Checks one group of sibling steps under `around`; returns its degree. */
  function cost(steps: PlanStep[], around: Around): Degree {
    const loops: Loop[] = [];
    /** Results made among these steps: name -> the degree of making them. */
    const made = new Map<string, Degree>();
    const coroutines = new Map<string, PlanStep>();
    /** One-time costs (and their degrees) among these steps. */
    let once: Degree = 0;
    const correlated: PlanStep[] = [];
    const names = steps
      .map((step) => ACCESS.exec(step.detail)?.[2])
      .filter((name) => name !== undefined);
    const built = (loop: Loop, base: Degree, columns?: string) => {
      // An index or Bloom filter SQLite builds once from a whole table (or
      // result), then looks rows up in.
      if (around.degree + base > 1)
        refuse(around, [], {
          ...loop,
          degree: base,
          reads: `read all of ${loop.name}`,
          advice: columns
            ? `give ${loop.name} an index on (${columns.replace(/=\?/g, "").replace(/ AND /g, ", ")})`
            : `give ${loop.name} an index on the column it ${around.subquery ? "compares" : "joins on"}`,
        });
      once = Math.max(once, base);
    };
    /** The degree of reading `name`: a table's, or what made the result. */
    const source = (name: string): Degree | undefined => {
      if (!made.has(name) && !coroutines.has(name)) return undefined;
      // Two steps of one name: a result and a table, told apart by nothing.
      if (names.filter((other) => other === name).length > 1)
        throw invalid(
          `its plan reads two things named ${name}; give them different names.`,
        );
      return made.get(name);
    };
    for (const step of steps) {
      const { detail } = step;
      const access = ACCESS.exec(detail);
      const virtual = VIRTUAL.exec(detail);
      if (
        detail === "SCAN CONSTANT ROW" ||
        /^SCAN \d+-ROW VALUES CLAUSE$/.test(detail)
      )
        loops.push({
          name: "VALUES",
          degree: 0,
          reads: "",
          advice: "",
          lookup: false,
        });
      else if (virtual) {
        const [, name, num, index] = virtual;
        const json = (num === "1" || num === "3") && index === "";
        const fts = Number(num) % 32 === 0 && FTS.test(index);
        if (!json && !fts) unknown(step);
        // A full-text table by rowid, or one JSON value: bounded. Read
        // whole, or searched (a MATCH can match every row): the table.
        const degree = json || index.includes("=") ? 0 : 1;
        loops.push({
          name,
          degree,
          reads:
            index === "" || index === "r"
              ? `read all of ${name}`
              : /[MLG]/.test(index)
                ? `search all of ${name}`
                : `search ${name} by a range`,
          advice: `search ${name} once, first, and find the rest by key`,
          lookup: degree === 0 && !json,
        });
      } else if (access) {
        const [, verb, name, , using, constraints] = access;
        const terms = constraints?.split(" AND ") ?? [];
        const equal =
          terms.length > 0 && terms.every((term) => EQUAL.test(term));
        const automatic = using?.startsWith("AUTOMATIC");
        let result = source(name);
        let coroutine = coroutines.get(name);
        if (coroutine && automatic) {
          // An automatic index on a co-routine's result runs it once to
          // fill the index.
          result = cost(under(coroutine), around);
          coroutines.delete(name);
          coroutine = undefined;
        } else if (coroutine && verb !== "SCAN") unknown(step);
        if (automatic) {
          if (!equal) unknown(step);
          built(
            { name, degree: 1, reads: "", advice: "", lookup: true },
            result ?? 1,
            constraints,
          );
        }
        const degree =
          equal && (verb === "SEARCH" || automatic) ? 0 : (result ?? 1);
        loops.push({
          name,
          degree,
          reads:
            result !== undefined || coroutine
              ? `read all of ${name}`
              : verb === "SEARCH" && terms.length > 0
                ? `search ${name} by a range`
                : `read all of ${name}`,
          advice:
            result !== undefined || coroutine
              ? "read it first, or join it on equal values"
              : verb === "SEARCH" && terms.length > 0
                ? around.subquery && !loops.some((loop) => loop.degree > 0)
                  ? "compare it on equal values"
                  : "join it on equal values"
                : `give ${name} an index on the column it ${around.subquery && !loops.some((loop) => loop.degree > 0) ? "compares" : "joins on"}`,
          lookup: degree === 0,
          coroutine,
        });
      } else if (detail === "MULTI-INDEX OR") {
        // Each branch finds its rows its own way, one after another.
        const branches = under(step);
        if (
          !branches.length ||
          branches.some((branch) => !/^INDEX \d+$/.test(branch.detail))
        )
          unknown(step);
        const running = loops.reduce((sum, loop) => sum + loop.degree, 0);
        const inside = {
          degree: around.degree + running,
          by: loops.find((loop) => loop.degree > 0)?.name ?? around.by,
          subquery: loops.some((loop) => loop.degree > 0)
            ? false
            : around.subquery,
        };
        const degree = Math.max(
          ...branches.map((branch) => cost(under(branch), inside)),
        );
        const name =
          under(branches[0])
            .map((s) => ACCESS.exec(s.detail)?.[2])
            .find(Boolean) ?? "it";
        loops.push({
          name,
          degree,
          reads: `read all of ${name}`,
          advice: "find it by equal values",
          lookup: false,
        });
      } else if (/^CO-ROUTINE /.test(detail)) {
        // Run as its result is read: costed there.
        coroutines.set(detail.slice("CO-ROUTINE ".length), step);
      } else if (/^MATERIALIZE /.test(detail)) {
        const degree = cost(under(step), around);
        made.set(detail.slice("MATERIALIZE ".length), degree);
        once = Math.max(once, degree);
      } else if (/^CORRELATED (SCALAR|LIST) SUBQUERY \d+$/.test(detail)) {
        correlated.push(step);
      } else if (/^(SCALAR|LIST) SUBQUERY \d+$/.test(detail)) {
        // Made once: a value, or a list an IN reads.
        const list = under(step);
        const degree = cost(list, around);
        once = Math.max(once, degree);
        // A list without a Bloom filter drives the loop before it: that loop
        // is searched once per value, for every row of the loops before it.
        if (
          /^LIST/.test(detail) &&
          !list.some((s) => s.detail === "CREATE BLOOM FILTER")
        )
          drive(degree, "a list read from a table");
      } else if (
        /^USING (INDEX \S+|ROWID SEARCH ON TABLE \S+) FOR IN-OPERATOR$/.test(
          detail,
        )
      ) {
        // An IN (SELECT ...) read from a table's own index: the list, or a
        // test of each row; the plan does not say which.
        drive(1, "a list read from a table");
      } else if (/^BLOOM FILTER ON \S+ \(.+\)$/.test(detail)) {
        const name = detail.split(" ")[3];
        built(
          { name, degree: 1, reads: "", advice: "", lookup: true },
          source(name) ?? 1,
        );
      } else if (
        /^USE TEMP B-TREE FOR /.test(detail) ||
        detail === "CREATE BLOOM FILTER"
      ) {
        // Sorting or deduplicating what the loops found: no more rows.
        if (under(step).length) unknown(step);
      } else if (
        /^(COMPOUND QUERY|LEFT-MOST SUBQUERY|UNION ALL|(UNION|INTERSECT|EXCEPT) USING TEMP B-TREE|MERGE \((UNION ALL|UNION|INTERSECT|EXCEPT)\)|LEFT|RIGHT|RIGHT-JOIN \S+)$/.test(
          detail,
        )
      ) {
        // Run one after another: a compound's parts, a RIGHT JOIN's pass
        // over the rows it did not match.
        once = Math.max(once, cost(under(step), around));
      } else unknown(step);
      // Only the steps above have steps of their own.
      if (
        (access ||
          virtual ||
          /^SCAN (CONSTANT ROW|\d+-ROW VALUES CLAUSE)$/.test(detail)) &&
        under(step).length
      )
        unknown(under(step)[0]);
    }

    function drive(degree: Degree, what: string) {
      const loop = loops.at(-1);
      if (!loop?.lookup || degree === 0) return;
      loop.degree = Math.max(loop.degree, degree);
      loop.reads = `search ${loop.name} once for every value of ${what}`;
      loop.advice = `join ${loop.name} to that table instead`;
      loop.lookup = false;
    }

    // Nested loops, in join order: their degrees add.
    let running = 0;
    for (const loop of loops) {
      if (loop.coroutine) {
        // A co-routine's steps run as it is read, inside the loops before.
        const before = loops.slice(0, loops.indexOf(loop));
        const by = before.find((other) => other.degree > 0);
        loop.degree = cost(
          under(loop.coroutine),
          by
            ? {
                degree: around.degree + running,
                by: by.name,
                subquery: false,
                advice: `read ${loop.name} first, or join it on equal values`,
              }
            : around,
        );
      }
      running += loop.degree;
      if (around.degree + running > 1) refuse(around, loops, loop);
    }
    // A correlated subquery runs for every row the loops find.
    let per = 0;
    for (const step of correlated) {
      const by = loops.find((loop) => loop.degree > 0);
      per = Math.max(
        per,
        cost(under(step), {
          degree: around.degree + running,
          by: by?.name ?? around.by,
          subquery: true,
        }),
      );
    }
    for (const coroutine of coroutines.values())
      if (!loops.some((loop) => loop.coroutine === coroutine))
        unknown(coroutine);
    return Math.max(running + per, once);
  }
}

function unknown(step: PlanStep): never {
  throw invalid(
    `its plan has a step Naru does not cost ("${step.detail}"); write the statement another way.`,
  );
}
