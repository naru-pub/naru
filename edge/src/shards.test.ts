import { describe, expect, test } from "vitest";
import {
  fnv1a32,
  mergeUnnotified,
  parseShards,
  SERVED,
  shardOf,
  siteOfPath,
} from "./shards";

describe("the hash", () => {
  test("is FNV-1a 32-bit, of UTF-8", () => {
    // The published test vectors, and what infra's cutover script
    // (naru-sdk-shard-migrate) checks itself against.
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    expect(fnv1a32("alpha")).toBe(0x5d8b6dab);
    expect(fnv1a32("limeburst")).toBe(0x5b907c1a);
    expect(fnv1a32("나루")).toBe(0xfaac13fa);
  });

  test("names a shard, unless an override does", () => {
    expect(shardOf("alpha", 4)).toBe(3);
    expect(shardOf("limeburst", 4)).toBe(2);
    expect(shardOf("_health", 4)).toBe(0);
    expect(shardOf("alpha", 1)).toBe(0);
    expect(shardOf("alpha", 4, new Map([["alpha", 1]]))).toBe(1);
    expect(shardOf("limeburst", 4, new Map([["alpha", 1]]))).toBe(2);
  });

  test("spreads names", () => {
    const counts = [0, 0, 0, 0];
    for (let n = 0; n < 4000; n++) counts[shardOf(`user${n}`, 4)] += 1;
    for (const count of counts) expect(count).toBeGreaterThan(850);
  });
});

describe("the shards' settings", () => {
  test("are the origins, in order, and the overrides", () => {
    const shards = parseShards(
      "http://127.0.0.1:40101, http://127.0.0.1:40102",
      '{"alpha": 1}',
    );
    expect(shards.origins).toEqual([
      "http://127.0.0.1:40101",
      "http://127.0.0.1:40102",
    ]);
    expect([...shards.overrides]).toEqual([["alpha", 1]]);
    expect(
      parseShards("http://127.0.0.1:40101", undefined).overrides.size,
    ).toBe(0);
    expect(parseShards("http://127.0.0.1:40101", "").overrides.size).toBe(0);
  });

  test("refuse what would send a site astray", () => {
    expect(() => parseShards(undefined, "{}")).toThrow(/names no shard/);
    expect(() => parseShards("127.0.0.1:40101", "{}")).toThrow(/not an origin/);
    expect(() => parseShards("http://127.0.0.1:1/x", "{}")).toThrow();
    expect(() => parseShards("http://a:1", '{"alpha": 1}')).toThrow(/of 1/);
    expect(() => parseShards("http://a:1", '{"alpha": "0"}')).toThrow();
    expect(() => parseShards("http://a:1", "[0]")).toThrow(/JSON object/);
    expect(() => parseShards("http://a:1", "{")).toThrow();
  });
});

describe("the site a path names", () => {
  test("in the data API", () => {
    expect(siteOfPath("/api/data/v1/alpha")).toBe("alpha");
    expect(siteOfPath("/api/data/v1/alpha/")).toBe("alpha");
    expect(siteOfPath("/api/data/v1/alpha/posts/one")).toBe("alpha");
    expect(siteOfPath("/api/data/v1/alpha/_live")).toBe("alpha");
    expect(siteOfPath("/api/data/v1/alpha/_files/a.png")).toBe("alpha");
    expect(siteOfPath("/api/data/v1/alpha/query/posts/list")).toBe("alpha");
    expect(siteOfPath("/api/data/v1/al%2Dpha/posts")).toBe("al-pha");
  });

  test("in the site operations, route renders among them", () => {
    expect(siteOfPath("/v1/sites/alpha/render")).toBe("alpha");
    expect(siteOfPath("/v1/sites/alpha/dump")).toBe("alpha");
    expect(siteOfPath("/v1/sites/alpha/restore")).toBe("alpha");
    expect(siteOfPath("/v1/sites/%61lpha/execute")).toBe("alpha");
  });

  test("nowhere else", () => {
    for (const path of [
      "/",
      "/healthz",
      "/healthz/deep",
      "/sdk/1/naru.js",
      "/v1/breakers/unnotified",
      "/v1/notifications/pending",
      "/v1/pageviews/drain",
      "/v1/domains/replace",
      "/api/data/v1/",
      "/api/data/v2/alpha",
      "/v1/sites/%E0%A4%A/dump",
    ])
      expect(siteOfPath(path)).toBeNull();
  });

  test("what the mini serves", () => {
    for (const path of [
      "/sdk/1/naru.js",
      "/api/data/v1/alpha",
      "/v1/sites/alpha/render",
      "/v1/breakers/unnotified",
      "/v1/notifications/pending",
    ])
      expect(SERVED.test(path)).toBe(true);
    for (const path of ["/", "/v1/pageviews/drain", "/v1/domains/replace"])
      expect(SERVED.test(path)).toBe(false);
  });
});

test("the unnotified sites, merged", () => {
  expect(
    mergeUnnotified([
      { sites: ["alpha", "beta"] },
      { sites: [] },
      { sites: ["gamma", "alpha"] },
    ]),
  ).toEqual({ sites: ["alpha", "beta", "gamma"] });
});
