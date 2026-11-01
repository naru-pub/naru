import { listCollections } from "./site-database";
import type { Site } from "./site-files";

// What write_file says back about a page or script it saved: the two Naru
// mistakes a model makes that the page itself won't show until later. A page
// that makes the SDK without { site } works on <login>.naru.pub and breaks
// on a custom domain; a page that uses a collection the site doesn't have
// fails when a visitor first uses it.

const COLLECTION = /\.collection\(\s*["'`]([^"'`$]+)["'`]/g;
// createNaru() or createNaru({ ... }) with no site in it.
const NO_SITE = /createNaru\(\s*(?:\)|\{(?![^}]*\bsite\b)[^}]*\}\s*\))/;

export async function pageWarnings(site: Site, path: string, source: string) {
  if (!/\.(html?|m?js)$/i.test(path) || path.startsWith("_naru/")) return [];
  const warnings: string[] = [];
  if (NO_SITE.test(source))
    warnings.push(
      `createNaru() without { site } breaks on a custom domain. Use createNaru({ site: "${site.loginName}" }).`,
    );
  const used = new Set([...source.matchAll(COLLECTION)].map((m) => m[1]));
  if (used.size) {
    try {
      const { collections } = (await listCollections(site)) as {
        collections: { name: string }[];
      };
      const have = new Set(collections.map((c) => c.name));
      const missing = [...used].filter((name) => !have.has(name));
      if (missing.length)
        warnings.push(
          `The site has no collection ${missing.join(", ")}. Create it with configure_collections, or change the page.`,
        );
    } catch {
      // A site without the database feature, or one moving hosts: the file
      // is saved, and there's nothing to compare against.
    }
  }
  return warnings;
}
