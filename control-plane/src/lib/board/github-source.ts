// The folder of a repository a GitHub-sourced template publishes, shared by
// the template's settings and the workflow's uploads, which find a template
// by it.
import { collapseSlashes } from "@/lib/site-urls";
import { BoardError } from "./board-error";

/** A folder of a repository, as `a/b` ('' for its root). */
export function normalizeGitHubPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = collapseSlashes(value.trim().replaceAll("\\", "/"))
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "");
  if (path === ".") return "";
  if (
    path.length > 200 ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new BoardError(400, "폴더 경로가 올바르지 않습니다.");
  }
  return path;
}
