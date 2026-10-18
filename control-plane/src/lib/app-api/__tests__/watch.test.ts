/** @jest-environment node */
import { describe, expect, jest, test } from "@jest/globals";
import { watchAppNotifications } from "../delivery";
import type { PushSender } from "../push";

const sender = (): PushSender => ({ send: async () => "delivered", close: jest.fn() });

describe("the worker's notification watch", () => {
  test("delivers on every pass until the worker stops, then closes its sender", async () => {
    const abort = new AbortController();
    const made = sender();
    let passes = 0;
    await watchAppNotifications(abort.signal, {
      everyMs: 1,
      makeSender: () => made,
      deliver: async () => {
        if (++passes === 3) abort.abort();
        return { sites: 1, stored: 0, pushed: 0 };
      },
    });
    expect(passes).toBe(3);
    expect(made.close).toHaveBeenCalledTimes(1);
  });

  test("keeps watching when the sender cannot be made or a pass fails", async () => {
    const abort = new AbortController();
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    let passes = 0;
    await watchAppNotifications(abort.signal, {
      everyMs: 1,
      makeSender: () => {
        if (++attempts === 1) throw new Error("no key");
        return sender();
      },
      deliver: async () => {
        if (++passes === 1) throw new Error("Worker away");
        abort.abort();
        return { sites: 0, stored: 0, pushed: 0 };
      },
    });
    expect(attempts).toBe(2);
    expect(passes).toBe(2);
    // Logged once, not on every failing pass.
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
