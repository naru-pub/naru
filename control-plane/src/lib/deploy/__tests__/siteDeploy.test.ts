/** @jest-environment node */
import { describe, expect, it } from "@jest/globals";

import { changedManifestPaths } from "../siteDeploy";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

describe("changedManifestPaths", () => {
  it("requests uploads only for new or changed files", () => {
    const previous = [
      { path: "index.html", sha256: hashA, size: 10, contentType: "text/html" },
      { path: "old.css", sha256: hashA, size: 20, contentType: "text/css" },
      { path: "same.js", sha256: hashA, size: 30 },
    ];
    const next = [
      { path: "index.html", sha256: hashB, size: 10, contentType: "text/html" },
      { path: "same.js", sha256: hashA, size: 30 },
      { path: "new.css", sha256: hashA, size: 20, contentType: "text/css" },
    ];

    expect(changedManifestPaths(previous, next)).toEqual([
      "index.html",
      "new.css",
    ]);
  });

  it("treats metadata-only changes as uploads", () => {
    const previous = [
      { path: "asset.txt", sha256: hashA, size: 10, contentType: "text/plain" },
    ];
    const next = [
      {
        path: "asset.txt",
        sha256: hashA,
        size: 10,
        contentType: "text/markdown",
      },
    ];

    expect(changedManifestPaths(previous, next)).toEqual(["asset.txt"]);
  });
});
