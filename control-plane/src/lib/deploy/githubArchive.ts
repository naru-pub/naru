import { gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { extract } from "tar-stream";
import { normalizeDeployPath, normalizeTargetPrefix } from "./siteDeploy";

// What of a repository a site gets. GitHub's archive of one commit is a
// gzipped tar with everything under one top folder (owner-repo-sha/). Only
// the chosen source folder is published, and in it only what a Naru site can
// serve: no dotfiles or dot-folders (.git, .github, .env), no node_modules, no
// links, and only the file types Naru hosts. What is left out is reported,
// so the owner sees it rather than wondering where a file went.

export const MAX_FILES = 5000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export class ArchiveError extends Error {}

export type ArchiveFile = { path: string; data: Buffer };

function skippedReason(path: string): string | null {
  const parts = path.split("/");
  if (parts.some((part) => part.startsWith("."))) return "dotfile";
  if (parts.includes("node_modules")) return "node_modules";
  try {
    normalizeDeployPath(path);
  } catch {
    return "type";
  }
  return null;
}

/**
 * The files a site gets from `archive` (gzipped tar), relative to
 * `sourceDir`, and the repository paths left out.
 */
export async function filesFromArchive(
  archive: Buffer,
  sourceDir: string,
): Promise<{ files: ArchiveFile[]; skipped: string[] }> {
  const folder = normalizeTargetPrefix(sourceDir);
  const files: ArchiveFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_TOTAL_BYTES * 2 });
  } catch {
    throw new ArchiveError(
      "The repository archive could not be read, or is larger than 200 MB unpacked.",
    );
  }
  const parser = extract();
  const done = new Promise<void>((resolve, reject) => {
    parser.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => chunks.push(chunk as Buffer));
      stream.on("error", reject);
      stream.on("end", () => {
        try {
          // Everything is under the archive's one top folder.
          const full = header.name.split("/").slice(1).join("/");
          const inside =
            folder === ""
              ? full
              : full.startsWith(`${folder}/`)
                ? full.slice(folder.length + 1)
                : null;
          if (inside === null || inside === "" || header.type === "directory")
            return next();
          if (header.type !== "file") {
            skipped.push(full);
            return next();
          }
          if (skippedReason(inside)) {
            skipped.push(full);
            return next();
          }
          const data = Buffer.concat(chunks);
          if (data.byteLength > MAX_FILE_BYTES)
            throw new ArchiveError(`${full} is larger than 10 MB.`);
          total += data.byteLength;
          if (total > MAX_TOTAL_BYTES)
            throw new ArchiveError("The site is larger than 100 MB.");
          files.push({ path: normalizeDeployPath(inside), data });
          if (files.length > MAX_FILES)
            throw new ArchiveError(
              `The site has more than ${MAX_FILES} files.`,
            );
          next();
        } catch (error) {
          reject(error);
        }
      });
    });
    parser.on("finish", resolve);
    parser.on("error", () =>
      reject(new ArchiveError("The repository archive could not be read.")),
    );
  });
  Readable.from([tar]).pipe(parser);
  await done;
  if (
    folder &&
    !files.length &&
    !skipped.some((path) => path.startsWith(`${folder}/`))
  )
    throw new ArchiveError(`The repository has no folder ${folder}.`);
  return { files, skipped };
}
