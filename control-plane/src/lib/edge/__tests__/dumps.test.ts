/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { DumpSummary } from "../dumps";

const encode = (text: string) => new TextEncoder().encode(text);
const lines = (...values: unknown[]) =>
  values.map((value) => `${JSON.stringify(value)}\n`).join("");
const header = { type: "header", version: 2, schema: [] };

test("a dump's summary counts rows by table, whatever their order or keys' order", () => {
  const summarize = (text: string, at: number) => {
    const summary = new DumpSummary();
    const bytes = encode(text);
    summary.push(bytes.subarray(0, at));
    summary.push(bytes.subarray(at));
    return summary.finish();
  };
  const one = lines(
    header,
    { type: "row", table: "meta", row: { key: "a", value: "가" } },
    { type: "row", table: "meta", row: { key: "b", value: "나" } },
    { type: "row", table: "site:t", row: { x: 1 } },
    { type: "end", rows: 3 },
  );
  const other = lines(
    header,
    { type: "row", table: "site:t", row: { x: 1 } },
    { type: "row", table: "meta", row: { value: "나", key: "b" } },
    { type: "row", table: "meta", row: { key: "a", value: "가" } },
    { type: "end", rows: 3 },
  );
  const summary = summarize(one, 50);
  expect(summary.meta.rows).toBe(2);
  expect(summary["site:t"].rows).toBe(1);
  expect(summarize(other, 61)).toEqual(summary);
  expect(
    summarize(other.replace('"value":"나"', '"value":"다"'), 10).meta.digest,
  ).not.toBe(summary.meta.digest);
  // A dump cut short has no summary.
  expect(() => summarize(one.split("\n").slice(0, 3).join("\n"), 5)).toThrow(
    /incomplete/,
  );
});
