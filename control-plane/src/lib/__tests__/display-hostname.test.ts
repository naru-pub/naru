/** @jest-environment node */
import { describe, it, expect } from "@jest/globals";
import { domainToUnicode } from "node:url";

import { displayHostname, displayUrl } from "../display-hostname";

describe("displayHostname", () => {
  it("decodes Korean, mixed and multi-label hostnames", () => {
    expect(displayHostname("xn--3l3bz7e1zj.love")).toBe("지새벽.love");
    expect(displayHostname("www.xn--3l3bz7e1zj.love")).toBe("www.지새벽.love");
    expect(displayHostname("xn--bcher-kva.example")).toBe("bücher.example");
    expect(displayHostname("xn--3e0b707e.xn--3e0b707e")).toBe("한국.한국");
  });

  it("leaves ASCII and malformed labels alone", () => {
    expect(displayHostname("example.com")).toBe("example.com");
    expect(displayHostname("xn--!!.com")).toBe("xn--!!.com");
  });

  it("agrees with node's decoder", () => {
    for (const host of [
      "xn--3l3bz7e1zj.love",
      "xn--o39an51b2re.com",
      "xn--mgbh0fb.xn--kgbechtv",
      "xn--fiqs8s.xn--fiqz9s",
      "xn--ls8h.la",
    ])
      expect(displayHostname(host)).toBe(domainToUnicode(host));
  });
});

describe("displayUrl", () => {
  it("decodes only the host", () => {
    expect(displayUrl("https://xn--3l3bz7e1zj.love")).toBe(
      "https://지새벽.love",
    );
    expect(displayUrl("https://xn--3l3bz7e1zj.love/a/xn--b?c")).toBe(
      "https://지새벽.love/a/xn--b?c",
    );
    expect(displayUrl("https://user.naru.pub")).toBe("https://user.naru.pub");
  });
});
