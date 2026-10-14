// The edge Worker keeps each site file it reads, and each it finds missing, in
// Cloudflare's cache (edge/src/pages.ts), so the control plane purges a file's
// entry whenever it changes (cache-purge.ts). Both build the entry's URL here.
//
// The entry is named by the file's bucket key, not by the request, so every
// path and host that serves one file shares it. The path is encoded whole, so
// no `..`, backslash or other segment the URL parser would rewrite can make
// one file's entry another's.

/** The cache entry of the bucket object `<login>/<path>`. */
export function edgeFileCacheUrl(platformDomain: string, objectKey: string) {
  const slash = objectKey.indexOf("/");
  const login = objectKey.slice(0, slash);
  const path = objectKey.slice(slash + 1);
  return `https://${login}.${platformDomain}/${encodeURIComponent(path)}`;
}

/**
 * A bucket object's path at the bucket's public domain, each segment
 * percent-encoded: the edge redirects to it and the control plane purges it,
 * so the URL a browser follows is the one purged. Unencoded, a `?` or `#` in
 * a name would end the path, and browsers encode some other characters
 * differently from encodeURIComponent, which the purge would miss.
 */
export function encodedObjectPath(objectKey: string) {
  return objectKey.split("/").map(encodeURIComponent).join("/");
}

/** Every cached file of one site, for purging the site whole. */
export function edgeSiteCacheTag(login: string) {
  return `naru-site-${login}`;
}
