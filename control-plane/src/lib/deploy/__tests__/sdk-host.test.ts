/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import {
  pointAtSdkHost,
  pointBytesAtSdkHost,
  SDK_REFERENCE_FILE,
} from "../sdk-host";

const ORIGIN = "https://sdk.naru.pub";

describe("pointing site files at the SDK's own host", () => {
  test("every naru.pub/sdk/ URL in a file changes together", () => {
    expect(
      pointAtSdkHost(
        [
          `<script type="module" src="https://naru.pub/sdk/1.1.0/naru.js"></script>`,
          `const { createNaru } = await import("https://naru.pub/sdk/1.1.0/naru.js");`,
          `import x from "//naru.pub/sdk/1/naru.js";`,
          `fetch("http://naru.pub/sdk/1.0.0/naru.d.ts");`,
        ].join("\n"),
        ORIGIN,
      ),
    ).toBe(
      [
        `<script type="module" src="https://sdk.naru.pub/sdk/1.1.0/naru.js"></script>`,
        `const { createNaru } = await import("https://sdk.naru.pub/sdk/1.1.0/naru.js");`,
        `import x from "//sdk.naru.pub/sdk/1/naru.js";`,
        `fetch("https://sdk.naru.pub/sdk/1.0.0/naru.d.ts");`,
      ].join("\n"),
    );
  });

  test("other naru.pub URLs, already-moved ones, and an unset origin are left alone", () => {
    for (const text of [
      `<a href="https://naru.pub/docs/sdk/">docs</a>`,
      `<a href="https://alice.naru.pub/sdk/x.js">a site's own sdk folder</a>`,
      `import("https://sdk.naru.pub/sdk/1.1.0/naru.js")`,
    ])
      expect(pointAtSdkHost(text, ORIGIN)).toBeNull();
    expect(
      pointAtSdkHost(`import("https://naru.pub/sdk/1.1.0/naru.js")`, ""),
    ).toBeNull();
  });

  test("bytes in another encoding survive untouched around the URL", () => {
    // "안녕" in EUC-KR, which is not valid UTF-8.
    const korean = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7]);
    const page = Buffer.concat([
      Buffer.from(`<meta charset="euc-kr"><p>`),
      korean,
      Buffer.from(`</p><script src="https://naru.pub/sdk/1/naru.js"></script>`),
    ]);
    const rewritten = pointBytesAtSdkHost(page, ORIGIN)!;
    expect(rewritten.subarray(26, 30)).toEqual(korean);
    expect(rewritten.toString("latin1")).toContain(
      `src="https://sdk.naru.pub/sdk/1/naru.js"`,
    );
  });

  test("only pages, scripts and import maps are read", () => {
    expect(
      ["index.html", "a.HTM", "app.js", "lib.mjs", "importmap.json"].every(
        (path) => SDK_REFERENCE_FILE.test(path),
      ),
    ).toBe(true);
    expect(
      ["style.css", "photo.png", "notes.txt"].some((path) =>
        SDK_REFERENCE_FILE.test(path),
      ),
    ).toBe(false);
  });
});
