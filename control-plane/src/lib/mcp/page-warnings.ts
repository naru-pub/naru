import { naruOrigin } from "./oauth";
import { listCollections } from "./site-database";
import type { Site } from "./site-files";

// What write_file says back about a page or script it saved: the two Naru
// mistakes a model makes that the page itself won't show until later. A page
// that makes the SDK without { site } works on <login>.naru.pub and breaks
// on a custom domain; a page that uses a collection the site doesn't have
// fails when a visitor first uses it. A page that uses the database on an
// account without one won't work at all, and the owner is who can change that.

const COLLECTION = /\.collection\(\s*["'`]([^"'`$]+)["'`]/g;
// createNaru() or createNaru({ ... }) with no site in it.
const NO_SITE = /createNaru\(\s*(?:\)|\{(?![^}]*\bsite\b)[^}]*\}\s*\))/;

/** What a model tells the owner of a site without the database feature. */
export const databasePlanNeeded = () =>
  `The site's database is part of the Naru supporter plan, which this account doesn't have now; its files need no plan. The owner can start a free trial or subscribe at ${naruOrigin()}/supporter.`;

export async function pageWarnings(
  site: Site,
  path: string,
  source: string,
  hasDatabase: boolean,
) {
  if (!/\.(html?|m?js)$/i.test(path) || path.startsWith("_naru/")) return [];
  const warnings: string[] = [];
  if (NO_SITE.test(source))
    warnings.push(
      `createNaru() without { site } breaks on a custom domain. Use createNaru({ site: "${site.loginName}" }).`,
    );
  const used = new Set([...source.matchAll(COLLECTION)].map((m) => m[1]));
  if (!hasDatabase) {
    if (used.size || source.includes("createNaru("))
      warnings.push(
        `This page uses the database, so it won't work yet. ${databasePlanNeeded()}`,
      );
  } else if (used.size) {
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
      // A site moving hosts: the file is saved, and there's nothing to compare
      // against.
    }
  }
  return warnings;
}
