import { pbkdf2Sync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { hashPassword, phcFromEarlier, verifyPassword } from "./passwords";

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

  test("hashes stored before PHC are respelled without the password", () => {
    // How Naru spelled them before: no leading $, a bare count, base64url.
    const salt = Buffer.from("fedcba9876543210fedcba9876543210", "hex");
    const bytes = pbkdf2Sync("1234", salt, 20_000, 32, "sha256");
    const earlier = `pbkdf2-sha256$20000$${salt.toString("base64url")}$${bytes.toString("base64url")}`;
    expect(verifyPassword("1234", earlier)).toBeNull();
    const respelled = phcFromEarlier(earlier)!;
    expect(respelled).toBe(
      `$pbkdf2-sha256$i=20000$${salt.toString("base64").replace(/=+$/, "")}$${bytes.toString("base64").replace(/=+$/, "")}`,
    );
    expect(verifyPassword("1234", respelled)).toBe(true);
    expect(verifyPassword("4321", respelled)).toBe(false);
    expect(phcFromEarlier(respelled)).toBeNull();
  });
});
