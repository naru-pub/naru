/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { forEachConcurrently } from "@/lib/board/concurrency";

describe("forEachConcurrently", () => {
  test("runs every item, at most `limit` at once", async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    await forEachConcurrently(
      Array.from({ length: 10 }, (_, i) => i),
      async (item) => {
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
        done.push(item);
      },
      3,
    );
    expect(most).toBe(3);
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("starts nothing after a failure, and throws once the rest settle", async () => {
    const started: number[] = [];
    let settled = 0;
    const failure = forEachConcurrently(
      [0, 1, 2, 3, 4, 5],
      async (item) => {
        started.push(item);
        if (item === 0) throw new Error("first");
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled++;
      },
      2,
    );
    await expect(failure).rejects.toThrow("first");
    // Item 1 was already running: it finished before the error came out.
    expect(started).toEqual([0, 1]);
    expect(settled).toBe(1);
  });
});
