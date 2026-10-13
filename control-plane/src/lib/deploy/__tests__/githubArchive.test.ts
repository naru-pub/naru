/** @jest-environment node */
import { describe, expect, it } from "@jest/globals";
import { filesFromArchive, MAX_FILE_BYTES } from "../githubArchive";
import { githubArchive } from "../__fixtures__/archive";

const paths = (files: { path: string }[]) =>
  files.map((file) => file.path).sort();

describe("filesFromArchive", () => {
  it("publishes what a site can serve, and reports what it leaves out", async () => {
    const { files, skipped } = await filesFromArchive(
      await githubArchive({
        "index.html": "<title>hi</title>",
        "css/site.css": "body{}",
        "vendor/purify.es.mjs": "export default {};",
        "README.md": "# readme",
        ".github/workflows/deploy.yml": "on: push",
        ".env": "SECRET=1",
        "node_modules/x/index.js": "x",
        "photo.heic": "binary",
        LICENSE: "MIT",
        "link.html": { link: "/etc/passwd" },
      }),
      "",
    );
    expect(paths(files)).toEqual([
      "README.md",
      "css/site.css",
      "index.html",
      "vendor/purify.es.mjs",
    ]);
    expect(
      files.find((file) => file.path === "index.html")!.data.toString(),
    ).toBe("<title>hi</title>");
    expect(skipped.sort()).toEqual([
      ".env",
      ".github/workflows/deploy.yml",
      "LICENSE",
      "link.html",
      "node_modules/x/index.js",
      "photo.heic",
    ]);
  });

  it("publishes one folder of the repository, relative to it", async () => {
    const archive = await githubArchive({
      "README.md": "repo",
      "site/index.html": "home",
      "site/about/index.html": "about",
      "sitemap/index.html": "not the folder",
    });
    const { files, skipped } = await filesFromArchive(archive, "/site/");
    expect(paths(files)).toEqual(["about/index.html", "index.html"]);
    expect(skipped).toEqual([]);
    await expect(filesFromArchive(archive, "docs")).rejects.toThrow(
      "The repository has no folder docs.",
    );
    await expect(filesFromArchive(archive, "../etc")).rejects.toThrow();
  });

  it("refuses files and archives past the limits", async () => {
    await expect(
      filesFromArchive(
        await githubArchive({
          "index.html": "x",
          "big.png": Buffer.alloc(MAX_FILE_BYTES + 1),
        }),
        "",
      ),
    ).rejects.toThrow("big.png is larger than 10 MB.");
    await expect(
      filesFromArchive(Buffer.from("not an archive"), ""),
    ).rejects.toThrow("could not be read");
  });
});
