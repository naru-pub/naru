import { describe, expect, test } from "@jest/globals";
import {
  ancestorsOf,
  editorUrl,
  filePaths,
  fuzzyFilter,
  fuzzyScore,
  renameSelection,
} from "../file-tree";

describe("file-tree", () => {
  test("lists the folders above a path", () => {
    expect(ancestorsOf("a/b/c.html")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("index.html")).toEqual([]);
  });

  test("lists every file in a tree", () => {
    expect(
      filePaths([
        { name: "index.html", path: "index.html", isDirectory: false },
        {
          name: "css",
          path: "css",
          isDirectory: true,
          children: [
            { name: "site.css", path: "css/site.css", isDirectory: false },
          ],
        },
      ]),
    ).toEqual(["index.html", "css/site.css"]);
  });

  test("names a file in the editor's address, each segment encoded", () => {
    expect(editorUrl(null)).toBe("/files");
    expect(editorUrl("blog/새 글.html")).toBe(
      `/files/edit/blog/${encodeURIComponent("새 글.html")}`,
    );
    expect(editorUrl("a/#b?.html")).toBe("/files/edit/a/%23b%3F.html");
  });

  test("selects a name without its extension to rename", () => {
    expect(renameSelection("site.min.css", false)).toBe(8);
    expect(renameSelection(".htaccess", false)).toBe(9);
    expect(renameSelection("v1.2", true)).toBe(4);
  });

  test("matches a query as a subsequence", () => {
    expect(fuzzyScore("sty", "css/style.css")).not.toBeNull();
    expect(fuzzyScore("xyz", "css/style.css")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  test("ranks matches in the file's own name first", () => {
    expect(
      fuzzyFilter("index", [
        "images/notes/dex.png",
        "blog/index.html",
        "index.html",
      ]),
    ).toEqual(["index.html", "blog/index.html", "images/notes/dex.png"]);
  });
});
