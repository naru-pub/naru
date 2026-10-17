/** @jest-environment node */
import { describe, expect, it } from "@jest/globals";

import {
  isTextFile,
  looksBinary,
  rewriteSdkUrlBytes,
  rewriteSdkUrls,
} from "../sdk-urls";

const NEW = "https://sdk.naru.pub/sdk/";

describe("rewriteSdkUrls", () => {
  it("rewrites every prefix form", () => {
    expect(
      rewriteSdkUrls('<script src="https://naru.pub/sdk/1.1.0/naru.js">'),
    ).toEqual({
      text: `<script src="${NEW}1.1.0/naru.js">`,
      count: 1,
    });
    expect(rewriteSdkUrls("http://naru.pub/sdk/1/a.js").text).toBe(
      `${NEW}1/a.js`,
    );
    expect(rewriteSdkUrls("import x from '//naru.pub/sdk/1/a.mjs'").text).toBe(
      "import x from '//sdk.naru.pub/sdk/1/a.mjs'",
    );
  });

  it("matches the scheme and host in any case, but not the path", () => {
    expect(rewriteSdkUrls("HTTPS://Naru.PUB/sdk/x").text).toBe(`${NEW}x`);
    expect(rewriteSdkUrls("//NARU.pub/sdk/x").text).toBe(
      "//sdk.naru.pub/sdk/x",
    );
    expect(rewriteSdkUrls("https://naru.pub/SDK/x").count).toBe(0);
  });

  it("leaves other paths and hosts", () => {
    for (const text of [
      "https://naru.pub/sdkfoo/x",
      "https://naru.pub/sdk",
      "https://naru.pub/docs/sdk/",
      "https://x.naru.pub/sdk/1/a.js",
      "//x.naru.pub/sdk/",
      "https://sdk.naru.pub/sdk/1/a.js",
      "//sdk.naru.pub/sdk/1/a.js",
      "https://naru.pubx/sdk/",
      "https://naru.pub.evil.com/sdk/",
      "https://notnaru.pub/sdk/",
      "https://my-naru.pub/sdk/",
      "ftp://naru.pub/sdk/",
      "xhttps://naru.pub/sdk/",
      "https://example.com//naru.pub/sdk/",
      "https://naru.pub:443/sdk/",
      "naru.pub/sdk/",
    ])
      expect([text, rewriteSdkUrls(text).count]).toEqual([text, 0]);
  });

  it("rewrites several in one file, and is idempotent", () => {
    const source = [
      '<script src="https://naru.pub/sdk/1.1.0/naru.js"></script>',
      '<link href="//naru.pub/sdk/1.1.0/naru.css">',
      "fetch('http://naru.pub/sdk/1.1.0/x.json')",
      "https://x.naru.pub/sdk/ stays",
    ].join("\n");
    const once = rewriteSdkUrls(source);
    expect(once.count).toBe(3);
    expect(once.text).toBe(
      [
        `<script src="${NEW}1.1.0/naru.js"></script>`,
        '<link href="//sdk.naru.pub/sdk/1.1.0/naru.css">',
        `fetch('${NEW}1.1.0/x.json')`,
        "https://x.naru.pub/sdk/ stays",
      ].join("\n"),
    );
    expect(rewriteSdkUrls(once.text)).toEqual({ text: once.text, count: 0 });
  });
});

describe("rewriteSdkUrlBytes", () => {
  it("keeps a BOM, CRLF and non-ASCII text byte for byte", () => {
    const before = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        '<p>안녕, 세상?</p>\r\n<script src="https://naru.pub/sdk/1/a.js"></script>\r\n',
        "utf8",
      ),
    ]);
    const { body, count, snippets } = rewriteSdkUrlBytes(before);
    expect(count).toBe(1);
    expect(body).toEqual(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          `<p>안녕, 세상?</p>\r\n<script src="${NEW}1/a.js"></script>\r\n`,
          "utf8",
        ),
      ]),
    );
    expect(snippets[0]).toContain("안녕");
    expect(snippets[0]).toContain("https://naru.pub/sdk/1/a.js");
  });

  it("keeps bytes that are not valid UTF-8", () => {
    const before = Buffer.concat([
      Buffer.from([0xc0, 0xff, 0x80]),
      Buffer.from("//naru.pub/sdk/a"),
      Buffer.from([0xfe]),
    ]);
    expect(rewriteSdkUrlBytes(before).body).toEqual(
      Buffer.concat([
        Buffer.from([0xc0, 0xff, 0x80]),
        Buffer.from("//sdk.naru.pub/sdk/a"),
        Buffer.from([0xfe]),
      ]),
    );
  });

  it("returns no body when nothing matches", () => {
    expect(rewriteSdkUrlBytes(Buffer.from("plain")).body).toBeNull();
  });
});

describe("isTextFile", () => {
  it("goes by extension, then content type", () => {
    expect(isTextFile("a/index.HTML")).toBe(true);
    expect(isTextFile("a/site.webmanifest")).toBe(true);
    expect(isTextFile("a/x.png", "image/png")).toBe(false);
    expect(isTextFile("a/README", "text/plain")).toBe(true);
    expect(isTextFile("a/data", "application/json; charset=utf-8")).toBe(true);
    expect(isTextFile("a/data")).toBe(false);
  });

  it("looksBinary finds a NUL", () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x00]))).toBe(true);
    expect(looksBinary(Buffer.from("text"))).toBe(false);
  });
});
