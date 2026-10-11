import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";

/**
 * A gzipped tar shaped like GitHub's archive of a commit: a pax global header,
 * then everything under one top folder. `entries` maps paths to contents, or
 * to `{ link }` for a symbolic link.
 */
export async function githubArchive(
  entries: Record<string, string | Buffer | { link: string }>,
  top = "owner-repo-0123abc",
) {
  const tar = pack();
  const chunks: Buffer[] = [];
  tar.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => tar.on("end", resolve));
  tar.entry({ name: "pax_global_header", type: "pax-global-header" }, "");
  tar.entry({ name: `${top}/`, type: "directory" });
  for (const [path, content] of Object.entries(entries)) {
    if (typeof content === "object" && !Buffer.isBuffer(content))
      tar.entry({
        name: `${top}/${path}`,
        type: "symlink",
        linkname: content.link,
      });
    else tar.entry({ name: `${top}/${path}` }, content);
  }
  tar.finalize();
  await ended;
  return gzipSync(Buffer.concat(chunks));
}
