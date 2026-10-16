import { publishSiteFunctions } from "@/lib/site-functions/releases";
import {
  DECLARATION_PATH,
  installDeclaredCollections,
} from "@/lib/site-data/declared-collections";
import * as Sentry from "@sentry/nextjs";
import {
  edgeFileCacheUrl,
  edgeSiteCacheTag,
  encodedObjectPath,
} from "@/lib/edge/file-cache";
import { getSiteBucketUrl, getUserObjectKey } from "@/lib/site-urls";

// After a site's files change, Cloudflare's copies of them go. The edge
// Worker keeps each HTML, JS and JSON file it serves, or its absence, in the
// cache under the file's own entry (lib/edge/file-cache.ts); the other files
// redirect to the bucket's public domain, r2.naru.pub, which caches them
// under their URL there. Both are purged. A failed purge only delays a
// change, so it is reported and not thrown.

/** Purges these paths of the user's site. */
export function purgeSiteFiles(loginName: string, paths: string[]) {
  return purgeSiteObjects(
    paths.map((path) => getUserObjectKey(loginName, path)),
  );
}

/** Purges these keys of the site bucket, each `<login>/<path>`. */
export async function purgeSiteObjects(keys: string[]) {
  const sites = new Set(
    keys.flatMap((key) => {
      const match =
        /^([^/]+)\/_naru\/(?:functions|modules|rules|migrations)\//.exec(key);
      return match ? [match[1]] : [];
    }),
  );
  for (const site of sites) await publishSiteFunctions(site);
  // After the functions, so the rules a declaration names are published.
  const declaring = new Set(
    keys.flatMap((key) => {
      const slash = key.indexOf("/");
      return key.slice(slash + 1) === DECLARATION_PATH
        ? [key.slice(0, slash)]
        : [];
    }),
  );
  for (const site of declaring)
    await installDeclaredCollections(site).catch((error) =>
      // The file is saved either way; /database shows what it asks.
      Sentry.captureException(error, { extra: { site } }),
    );
  const domain = process.env.NEXT_PUBLIC_DOMAIN!;
  const urls = keys.flatMap((key) => [
    edgeFileCacheUrl(domain, key),
    // As the edge redirects to it.
    getSiteBucketUrl(encodedObjectPath(key)),
  ]);
  await purgeUrls(urls);
  // A request that read a file just before it changed stores the old copy
  // when its read finishes, which can be after this purge; the copy would
  // then stay for a day (SITE_FILE_CACHE_SECONDS), so a page could load a new
  // index.html with an old module. Purge again once such reads are done.
  setTimeout(() => void purgeUrls(urls), REPURGE_AFTER_MS).unref?.();
}

/** How long after a purge it is repeated, past any read still storing. */
export const REPURGE_AFTER_MS = 30_000;

/** Purges every file of the user's site the edge keeps, for its deletion. */
export function purgeSite(loginName: string) {
  return purge({ tags: [edgeSiteCacheTag(loginName)] });
}

/** Purges URLs from Cloudflare's cache, 30 per call as the API allows. */
export async function purgeUrls(urls: string[]): Promise<void> {
  for (let i = 0; i < urls.length; i += 30)
    await purge({ files: urls.slice(i, i + 30) });
}

async function purge(body: { files: string[] } | { tags: string[] }) {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const apiToken = process.env.CLOUDFLARE_USER_API_TOKEN;
  if (!zoneId || !apiToken) return;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      Sentry.captureMessage(
        `Cloudflare purge failed: ${response.status} ${await response.text()}`,
      );
    }
  } catch (error) {
    Sentry.captureException(error);
  }
}
