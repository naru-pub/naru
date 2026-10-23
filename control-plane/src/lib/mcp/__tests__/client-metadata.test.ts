/**
 * @jest-environment node
 */
import { describe, expect, test } from "@jest/globals";
import {
  fetchMetadataDocument,
  isMetadataUrl,
  isPublicAddress,
} from "../client-metadata";

describe("reading a Client ID Metadata Document", () => {
  test("takes only https URLs with a path on the default port", () => {
    expect(
      isMetadataUrl("https://claude.ai/oauth/claude-code-client-metadata"),
    ).toBe(true);
    for (const value of [
      "http://claude.ai/client.json",
      "https://claude.ai/",
      "https://claude.ai:8443/client.json",
      "https://user:pw@claude.ai/client.json",
      "https://claude.ai/client.json#x",
      "01a16884-de2f-7785-bdd8-ea5d1786b7e0",
    ])
      expect(isMetadataUrl(value)).toBe(false);
  });

  test("tells public addresses from private ones", () => {
    for (const address of ["160.79.104.10", "1.1.1.1", "2606:4700:4700::1111"])
      expect(isPublicAddress(address)).toBe(true);
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.68.62",
      "169.254.169.254",
      "100.100.1.1",
      "0.0.0.0",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:192.168.0.1",
      "not an address",
    ])
      expect(isPublicAddress(address)).toBe(false);
  });

  test("never connects to this machine or an address literal", async () => {
    await expect(
      fetchMetadataDocument("https://localhost/client.json"),
    ).rejects.toThrow("not a public address");
    await expect(
      fetchMetadataDocument("https://127.0.0.1/client.json"),
    ).rejects.toThrow("not an address");
  });
});
