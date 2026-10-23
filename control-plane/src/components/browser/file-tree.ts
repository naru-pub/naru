import type { FileNode } from "@/lib/fileUtils";
import { EDITABLE_FILE_EXTENSIONS } from "@/lib/const";

// Helpers the file manager's components share for walking the tree buildFileTree
// returns and for naming files in the editor's URLs.

export const extensionOf = (path: string) => {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export const isEditable = (path: string) =>
  EDITABLE_FILE_EXTENSIONS.includes(extensionOf(path));

export const isHtml = (path: string) => /\.html?$/i.test(path);

export const basename = (path: string) => path.split("/").pop() ?? "";

/** The folder a path is in: "" for the home directory. */
export const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** Whether `path` is `folder` or inside it. */
export const isWithin = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`);

/** Every folder above a path, outermost first: "a/b/c.html" → ["a", "a/b"]. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  return parts
    .slice(0, -1)
    .map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

/** The paths of every file in the tree, folders left out. */
export function filePaths(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) =>
    node.isDirectory ? filePaths(node.children ?? []) : [node.path],
  );
}

/** The file manager's address for a file: /files/edit/<path>. */
export function editorUrl(path: string | null) {
  if (!path) return "/files";
  return `/files/edit/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The selection a rename starts with: the name without its extension. */
export function renameSelection(name: string, isDirectory: boolean) {
  const dot = name.lastIndexOf(".");
  return isDirectory || dot <= 0 ? name.length : dot;
}

/**
 * How well `query` matches `path` as a subsequence of its characters, the way
 * an editor's quick open does: null for no match, else higher is better.
 * Matches in the file's own name, at word starts and in runs score higher.
 */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf("/") + 1;

  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    const at = p.indexOf(char, from);
    if (at < 0) return null;
    score += 1;
    if (at === previous + 1) score += 3;
    if (at === 0 || "/-_. ".includes(p[at - 1])) score += 2;
    if (at >= nameStart) score += 2;
    previous = at;
    from = at + 1;
  }
  // Prefer shorter paths among equal matches.
  return score - p.length / 100;
}

export function fuzzyFilter(query: string, paths: string[], limit = 50) {
  return paths
    .map((path) => ({ path, score: fuzzyScore(query, path) }))
    .filter((match): match is { path: string; score: number } =>
      match.score !== null,
    )
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((match) => match.path);
}
