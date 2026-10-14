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
  tar.on("data", (chunk) => chunks.push(chunk as Buffer));
  const ended = new Promise<void>((resolve) => tar.on("end", () => resolve()));
  // tar-stream cannot write a pax global header's type, so, as it always
  // has here, this is a plain entry under the name GitHub's carries.
  tar.entry({ name: "pax_global_header" }, "");
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
