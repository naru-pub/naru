import { describe, expect, test } from "vitest";
import { callerKey } from "./addresses";

describe("callerKey", () => {
  test("keeps an IPv4 address and groups IPv6 by its /64", () => {
    expect(callerKey("203.0.113.7")).toBe("203.0.113.7");
    expect(callerKey(undefined)).toBe("unknown");
    const same = [
      "2001:db8:1:2::1",
      "2001:db8:1:2:ffff:ffff:ffff:ffff",
      "2001:0DB8:0001:0002:0:0:0:9",
    ].map(callerKey);
    expect(new Set(same)).toEqual(new Set(["2001:db8:1:2::/64"]));
    expect(callerKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(callerKey("::1")).toBe("0:0:0:0::/64");
    expect(callerKey("2001:db8::")).toBe("2001:db8:0:0::/64");
  });
});
