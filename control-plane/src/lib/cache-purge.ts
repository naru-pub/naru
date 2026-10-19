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

type PurgeOptions = {
  /**
   * The workflow deployment making the change, whose site code activates
   * after the purge returns (publishSiteFunctions).
   */
  deploymentId?: string;
};

/** Purges these paths of the user's site. */
export function purgeSiteFiles(
  loginName: string,
  paths: string[],
  options?: PurgeOptions,
) {
  return purgeSiteObjects(
    paths.map((path) => getUserObjectKey(loginName, path)),
    options,
  );
}

/**
 * Purges these keys of the site bucket, each `<login>/<path>`. Returns the
 * function releases the change published, by site.
 */
export async function purgeSiteObjects(
  keys: string[],
  options: PurgeOptions = {},
) {
  const sites = new Set(
    keys.flatMap((key) => {
      const match =
        /^([^/]+)\/_naru\/(?:modules|shared|migrations|queries|mutations|routes)\//.exec(
          key,
        );
      return match ? [match[1]] : [];
    }),
  );
  const releases = new Map<string, { revision: string; generation: string }>();
  for (const site of sites)
    releases.set(
      site,
      await publishSiteFunctions(site, { deploymentId: options.deploymentId }),
    );
  // After the site's code, as before: a declaration installs on its own.
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
  return releases;
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
