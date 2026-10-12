import { describe, expect, test } from "vitest";
import {
  fingerprint,
  versionedSrcset,
  versionedUrl,
  versionsAssets,
  type AssetEnv,
} from "./assets";

const env: AssetEnv = {
  PLATFORM_DOMAIN: "naru.pub",
  R2_PUBLIC_DOMAIN: "r2.naru.pub",
  VERSIONED_ASSET_SITES: "alice, bob",
};
const SERVED = ["html", "htm", "js", "json"];
const etags: Record<string, string> = {
  "alice/js/app.js": '"0123456789abcdef"',
  "alice/css/site.css": '"fedcba9876543210"',
  "alice/img/a cat.png": '"aaaaaaaaaaaabbbb"',
  "alice/img/cat@2x.png": '"cccccccccccc0000-2"',
};
const lookups: string[] = [];
const etagOf = async (key: string) => {
  lookups.push(key);
  return etags[key] ?? null;
};
const page = new URL("https://alice.naru.pub/blog/post.html");
const version = (ref: string, base = page) =>
  versionedUrl(ref, base, "alice", env, SERVED, etagOf);

describe("versioned asset URLs", () => {
  test("are only for the listed sites, or every site with *", () => {
    expect(versionsAssets(env, "bob")).toBe(true);
    expect(versionsAssets(env, "carol")).toBe(false);
    expect(
      versionsAssets({ ...env, VERSIONED_ASSET_SITES: "*" }, "carol"),
    ).toBe(true);
    expect(
      versionsAssets({ ...env, VERSIONED_ASSET_SITES: undefined }, "bob"),
    ).toBe(false);
  });

  test("name a version by the start of the ETag", () => {
    expect(fingerprint('"0123456789abcdef"')).toBe("0123456789ab");
    expect(fingerprint('W/"0123456789abcdef"')).toBe("0123456789ab");
  });

  test("keep files the edge serves on the site, and send the rest to the bucket's domain", async () => {
    expect(await version("../js/app.js")).toBe("/js/app.js?v=0123456789ab");
    expect(await version("/css/site.css")).toBe(
      "https://r2.naru.pub/alice/css/site.css?v=fedcba987654",
    );
    expect(await version("https://alice.naru.pub/img/a%20cat.png#top")).toBe(
      "https://r2.naru.pub/alice/img/a%20cat.png?v=aaaaaaaaaaaa#top",
    );
  });

  test("leave alone what is not one of the site's own existing files", async () => {
    for (const ref of [
      "https://cdn.example/lib.js",
      "//cdn.example/lib.js",
      "data:image/png;base64,AAAA",
      "/css/site.css?v=2",
      "/img/",
      "/img/missing.png",
      "http://alice.naru.pub/css/site.css",
    ])
      expect(await version(ref)).toBeNull();
  });

  test("resolve against the page's <base>", async () => {
    expect(await version("app.js", new URL("https://alice.naru.pub/js/"))).toBe(
      "/js/app.js?v=0123456789ab",
    );
  });

  test("version each candidate of a srcset", async () => {
    expect(
      await versionedSrcset(
        "/img/a%20cat.png 1x, /img/cat@2x.png 2x, https://cdn.example/c.png 3x",
        (ref) => version(ref),
      ),
    ).toBe(
      "https://r2.naru.pub/alice/img/a%20cat.png?v=aaaaaaaaaaaa 1x, " +
        "https://r2.naru.pub/alice/img/cat%402x.png?v=cccccccccccc 2x, " +
        "https://cdn.example/c.png 3x",
    );
  });
});
