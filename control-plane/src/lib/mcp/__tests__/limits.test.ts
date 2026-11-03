import {
  FREE_REQUESTS_PER_MINUTE,
  FREE_SITE_BYTES,
  FREE_WRITE_BYTES_PER_DAY,
  FREE_WRITES_PER_DAY,
  freeWrite,
  type FreeWrite,
  HARD_CAP_FACTOR,
  overRequestLimit,
  PLAN_REQUESTS_PER_MINUTE,
  resetLimits,
} from "../limits";
import { beforeEach, describe, expect, test } from "@jest/globals";

const said = (write: FreeWrite) =>
  write.refused !== undefined ? write.refused : write.over;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

beforeEach(resetLimits);

describe("requests a minute", () => {
  const sent = (user: string, entitled: boolean, count: number, now = 0) =>
    Array.from({ length: count }, () => overRequestLimit(user, entitled, now));

  test("stop at the account's limit, tighter without a plan", () => {
    expect(sent("free", false, FREE_REQUESTS_PER_MINUTE)).not.toContain(true);
    expect(overRequestLimit("free", false, 0)).toBe(true);
    expect(sent("paid", true, PLAN_REQUESTS_PER_MINUTE)).not.toContain(true);
    expect(overRequestLimit("paid", true, 0)).toBe(true);
  });

  test("start again the next minute, and apart for each account", () => {
    sent("free", false, FREE_REQUESTS_PER_MINUTE + 1);
    expect(overRequestLimit("other", false, 0)).toBe(false);
    expect(overRequestLimit("free", false, MINUTE)).toBe(false);
  });
});

describe("writes without a plan", () => {
  test("go on past the day's files, saying so, and stop far past them", () => {
    for (let i = 0; i < FREE_WRITES_PER_DAY; i++)
      expect(freeWrite("a", 1, 0, 0)).toEqual({ over: null, crossed: false });
    const first = freeWrite("a", 1, 0, 0);
    expect(first).toMatchObject({ crossed: true });
    expect(said(first)).toContain("files through MCP today");
    expect(freeWrite("a", 1, 0, 0)).toMatchObject({ crossed: false });
    for (
      let i = FREE_WRITES_PER_DAY + 3;
      i < FREE_WRITES_PER_DAY * HARD_CAP_FACTOR;
      i++
    )
      freeWrite("a", 1, 0, 0);
    expect(freeWrite("a", 1, 0, 0).refused).toBeUndefined();
    expect(freeWrite("a", 1, 0, 0).refused).toContain("refused");
    expect(freeWrite("a", 1, 0, DAY)).toEqual({ over: null, crossed: false });
  });

  test("go on past the day's bytes, without counting what was refused", () => {
    expect(freeWrite("a", FREE_WRITE_BYTES_PER_DAY, 0, 0)).toMatchObject({
      over: null,
    });
    const past = freeWrite("a", 1, 0, 0);
    expect(past).toMatchObject({ crossed: true });
    expect(said(past)).toContain("MB through MCP today");
    const huge = FREE_WRITE_BYTES_PER_DAY * HARD_CAP_FACTOR;
    expect(freeWrite("b", huge + 1, 0, 0).refused).toContain("refused");
    expect(freeWrite("b", huge, 0, 0).refused).toBeUndefined();
  });

  test("go on past the site's size, with what was written since it was measured", () => {
    const measured = FREE_SITE_BYTES - 10;
    expect(freeWrite("a", 10, measured, 0)).toMatchObject({ over: null });
    const past = freeWrite("a", 1, measured, 0);
    expect(said(past)).toContain("GB");
    const far = FREE_SITE_BYTES * HARD_CAP_FACTOR;
    expect(freeWrite("b", 1, far, 0).refused).toContain("refused");
  });
});
