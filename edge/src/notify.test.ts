import { describe, expect, test } from "vitest";
import { MAX_NOTIFY_RECIPIENTS, notification } from "./notify";

const member = "0199f2a4-7c1e-7d3a-9b2f-1a2b3c4d5e6f";

describe("ctx.notify's arguments", () => {
  test("defaults body to empty and path to the site's front page", () => {
    expect(notification([member, member], { title: "새 댓글" })).toEqual({
      members: [member],
      title: "새 댓글",
      body: "",
      path: "/",
    });
  });

  test("takes a path on the site, never another address", () => {
    expect(
      notification([member], { title: "t", path: "/posts/12?c=3#r" }).path,
    ).toBe("/posts/12?c=3#r");
    for (const path of [
      "https://evil.example/",
      "//evil.example/",
      "posts/12",
      "/\\evil",
      "/a\nb",
    ])
      expect(() => notification([member], { title: "t", path })).toThrow(
        /path is a path on the site/,
      );
  });

  test("cuts a long title and body, never within a character", () => {
    const long = notification([member], {
      title: "가".repeat(101),
      body: "x".repeat(501),
    });
    expect(long.title).toBe("가".repeat(100));
    expect(long.body).toBe("x".repeat(500));
    // 100 emoji are 200 UTF-16 units, and all fit.
    expect(notification([member], { title: "🥑".repeat(100) }).title).toBe(
      "🥑".repeat(100),
    );
    expect(notification([member], { title: "🥑".repeat(101) }).title).toBe(
      "🥑".repeat(100),
    );
  });

  test("refuses what the app cannot show", () => {
    expect(() => notification([member], { title: "" })).toThrow(/title/);
    expect(() => notification([member], { title: "  " })).toThrow(/title/);
    expect(() => notification([member], { title: 1 })).toThrow(/title/);
    expect(() => notification([member], { title: "t", body: 1 })).toThrow(
      /body/,
    );
    expect(() =>
      notification([member], { title: "t", url: "https://x" }),
    ).toThrow(/unknown field url/);
    expect(() => notification(member, { title: "t" })).toThrow(/member ids/);
    expect(() => notification(["alice"], { title: "t" })).toThrow(/member ids/);
  });

  test("names at most so many members", () => {
    const many = Array.from(
      { length: MAX_NOTIFY_RECIPIENTS + 1 },
      (_, i) => `0199f2a4-7c1e-7d3a-9b2f-${String(i).padStart(12, "0")}`,
    );
    expect(() => notification(many, { title: "t" })).toThrow(/at most/);
  });
});
