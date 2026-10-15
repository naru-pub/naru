import { describe, expect, test } from "vitest";
import { hashPassword, verifyPassword } from "./passwords";

describe("document secrets", () => {
  test("are PHC strings that check only their own password", () => {
    const hash = hashPassword("guest pass");
    expect(hash).toMatch(
      /^\$pbkdf2-sha256\$i=20000\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(verifyPassword("guest pass", hash)).toBe(true);
    expect(verifyPassword("guess", hash)).toBe(false);
    expect(verifyPassword("guest pass", "not a hash")).toBeNull();
  });
});
