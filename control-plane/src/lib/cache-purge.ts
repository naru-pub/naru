import { publishSiteFunctions } from "@/lib/site-functions/releases";
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
      const match = /^([^/]+)\/_naru\/(?:functions|modules|rules)\//.exec(key);
      return match ? [match[1]] : [];
    }),
  );
  for (const site of sites) await publishSiteFunctions(site);
  const domain = process.env.NEXT_PUBLIC_DOMAIN!;
  return purgeUrls(
    keys.flatMap((key) => [
      edgeFileCacheUrl(domain, key),
      // As the edge redirects to it.
      getSiteBucketUrl(encodedObjectPath(key)),
    ]),
  );
}

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
